/**
 * Review the finished translation — one call, findings only.
 *
 * Nothing here changes a chunk. The stage writes translation_review.json; the
 * monitor shows the findings beside the chunks they name, and a human decides
 * which become work. The same rule the glossary review follows, for the same
 * reason: every finding is a judgement about a book, and there is no class of
 * them that cannot be wrong.
 *
 * The contract the findings must pass is in core/translation_review.js.
 */

import fs from 'fs';
import { HumanMessage } from '@langchain/core/messages';
import { llmManager, bookModelEnabled, explainCallFailure } from '../core/llm_client.js';
import { usageTracker } from '../core/usage_tracker.js';
import { extractJson } from '../utils/parsers.js';
import { countTokens } from '../core/tokenizer.js';
import { verifyFindings } from '../core/translation_review.js';
import { loadPassport, isEmptyPassport } from '../core/passport.js';
import config from '../config.js';
import { getPrompts } from '../prompts.js';

// What a free tier accepts in one minute. The context window is not the binding
// constraint — measured on Gemini's free tier, tokens per minute is, and it
// refuses the call outright rather than truncating.
const TOKEN_BUDGET = config.pipeline.bookCallTokenBudget || 250000;

export async function runTranslationReviewStage(state) {
    console.log('--- SYSTEM: Reviewing the finished translation ---');
    usageTracker.setStage('translation_review');

    if (!bookModelEnabled()) {
        console.error('[Review] The large model is switched off (book_model.enabled), and this pass is nothing but ' +
            'one call to it. Turn it on in Settings → Large model.');
        process.exitCode = 1;
        return;
    }

    const chunks = state.getChunks();
    const translated = chunks.filter(c => c.translation);
    if (!translated.length) {
        console.error('[Review] Nothing is translated yet — there is nothing to review.');
        process.exitCode = 1;
        return;
    }
    if (translated.length < chunks.length) {
        console.warn(`[Review] Only ${translated.length} of ${chunks.length} chunks are translated. ` +
            `The review will read a book with holes in it, and may report a break in style that is really a gap.`);
    }

    // Bare original→translation pairs. The full glossary costs 26,008 tokens on
    // Morphotrophic against 8,603 for the pairs, and its dossiers describe
    // characters for a translator who has already finished.
    let pairs = [];
    const glossaryPath = state.getGlossaryPath();
    if (fs.existsSync(glossaryPath)) {
        try {
            const glossary = JSON.parse(fs.readFileSync(glossaryPath, 'utf-8'));
            pairs = (Array.isArray(glossary) ? glossary : [])
                .filter(t => t?.original && t?.translation)
                .map(t => [String(t.original), String(t.translation)]);
        } catch (e) {
            console.warn(`[Review] Could not read the glossary (${e.message}) — reviewing without it.`);
        }
    }

    // A rerun overwrites the file, so decisions made about the previous findings
    // have to be carried across first. Keyed by what a finding says rather than
    // where it sat, so a model that repeats itself stays dismissed.
    const reviewPath = state.getTranslationReviewPath();
    let carriedDismissals = [];
    if (fs.existsSync(reviewPath)) {
        try {
            const previous = JSON.parse(fs.readFileSync(reviewPath, 'utf-8'));
            carriedDismissals = Array.isArray(previous.dismissed) ? previous.dismissed : [];
            if (carriedDismissals.length) {
                console.log(`[Review] Carrying over ${carriedDismissals.length} finding(s) you had dismissed.`);
            }
        } catch { /* an unreadable previous review must not block a new one */ }
    }

    // The decisions the book was translated under. Without them the reviewer has
    // to infer the intent from the text, which makes the majority right by
    // definition — and, worse, leaves it unable to route its own findings: it is
    // asked to send some to the passport while never having seen it, so it
    // cannot tell "the passport says nothing about this" from "the passport says
    // it and this chunk disobeyed", which are different repairs.
    //
    // The point-of-view map is left out. It is written in chunk indices, and the
    // reviewer is given one joined text with no chunk boundaries in it; 62 spans
    // on Morphotrophic would be 1,400 tokens of numbers it cannot resolve. What
    // stays costs 700 tokens against a 193,400-token prompt.
    const passport = loadPassport(state.getPassportPath());
    const intent = isEmptyPassport(passport) ? null : {
        kind: passport.kind || undefined,
        register: passport.register || undefined,
        narration: passport.narration?.person ? passport.narration : undefined,
        author: passport.author?.gender ? { name: passport.author.name, gender: passport.author.gender } : undefined,
        dialogue: passport.dialogue?.marker ? { marker: passport.dialogue.marker, sample: passport.dialogue.sample } : undefined,
        characters: passport.characters?.length ? passport.characters : undefined,
        voices: passport.voices?.length ? passport.voices : undefined,
        addressRegistry: passport.addressRegistry?.length ? passport.addressRegistry : undefined,
    };
    if (intent) console.log(`[Review] Sending the passport's decisions along: the reviewer needs to know what was intended.`);
    else console.log(`[Review] No passport — the reviewer will have to judge the text against its own idea of what it should be.`);

    const translationText = chunks.map(c => c.translation || '').filter(Boolean).join('\n');
    const targetLang = state.data.metadata?.targetLanguage || config.translation.targetLanguage;
    const prompts = getPrompts(config.translation.promptLang);

    // --- does it fit? ---
    const textTokens = countTokens(translationText);
    const glossaryTokens = pairs.length ? countTokens(JSON.stringify(pairs)) : 0;
    const intentTokens = intent ? countTokens(JSON.stringify(intent)) : 0;
    const total = textTokens + glossaryTokens + intentTokens;
    const fmt = n => n.toLocaleString('en-US');
    console.log(`[Review] Prompt: ~${fmt(textTokens)} tokens of translation + ~${fmt(glossaryTokens)} of glossary` +
        `${intentTokens ? ` + ~${fmt(intentTokens)} of passport` : ''} = ~${fmt(total)}.`);

    if (total > TOKEN_BUDGET) {
        console.error(`\n[Review] TOO LARGE: ~${fmt(total)} tokens against a budget of ${fmt(TOKEN_BUDGET)}.`);
        console.error(`[Review] The translation has to be sent whole: half a book cannot show that a term is`);
        console.error(`[Review] rendered two ways or that a voice drifts, which is the entire point of this pass.`);
        console.error(`[Review] Either raise the limit for a paid tier, or read this one by hand.\n`);
        process.exitCode = 1;
        return;
    }

    let client, conf, provider;
    try {
        ({ conf, provider } = llmManager.getBookSettings());
        client = llmManager.getClient('book');
    } catch (e) {
        console.error(`[Review] The large model is not configured: ${e.message}`);
        process.exitCode = 1;
        return;
    }
    console.log(`[Review] Asking ${conf.modelName} to read the whole translation...`);

    let raw;
    try {
        const response = await client.invoke([
            new HumanMessage(prompts.translationReview.system(targetLang)),
            new HumanMessage(prompts.translationReview.user(translationText, pairs, intent)),
        ]);
        raw = extractJson(response.content || '');
    } catch (e) {
        console.error(`[Review] The whole-book call failed — ${explainCallFailure(e, provider, conf)}`);
        if (e.contentBlocked) {
            console.error('[Review] The provider refused the text. Retrying will not help — switch the book_model provider.');
        }
        process.exitCode = 1;
        return;
    }

    const list = Array.isArray(raw?.findings) ? raw.findings : (Array.isArray(raw) ? raw : []);
    const { findings, rejected, rejectedFindings } = verifyFindings(list, chunks);

    const dropped = Object.values(rejected).reduce((a, b) => a + b, 0);
    console.log(`[Review] ${list.length} finding(s) returned, ${findings.length} passed verification` +
        `${dropped ? `, ${dropped} dropped` : ''}.`);
    if (dropped) {
        const names = {
            malformed: 'malformed or an unknown scope',
            badQuote: 'quote not found in the translation',
            ambiguousQuote: 'quote occurs in more than one chunk',
            noAdvice: 'asked for a fix without saying what to do',
        };
        for (const [key, n] of Object.entries(rejected)) {
            if (n) console.log(`[Review]   ${n} × ${names[key]}`);
        }
        console.log(`[Review] The dropped findings are kept in "rejectedFindings" with the check each failed.`);
    }
    if (rejected.badQuote) {
        console.log(`[Review] Note: a quote that is not in the translation means the model wrote from memory ` +
            `rather than from the text in front of it.`);
    }

    const score = Number(raw?.score);
    const review = {
        generatedAt: new Date().toISOString(),
        model: conf.modelName,
        chunks: chunks.length,
        translated: translated.length,
        returned: list.length,
        // The model's opinion, stored as one. Measured across five books, the
        // per-chunk reviewer's score has a median of 10 and never falls below 9,
        // so a number from a single call is not a metric and must not be shown
        // as though it were comparable between runs. The findings are.
        score: Number.isFinite(score) ? score : null,
        summary: String(raw?.summary || '').trim() || null,
        // Findings a person has judged wrong, by findingKey. The interface writes
        // here, and a rerun carries the list over.
        dismissed: carriedDismissals,
        rejected,
        findings,
        // Deliberately last and under a name nothing else reads: these failed
        // verification and must not be one careless join away from the interface.
        rejectedFindings,
    };
    fs.writeFileSync(reviewPath, JSON.stringify(review, null, 2));

    // --- report ---
    if (findings.length) {
        const byScope = {}, byIssue = {};
        for (const f of findings) {
            byScope[f.scope] = (byScope[f.scope] || 0) + 1;
            byIssue[f.issue] = (byIssue[f.issue] || 0) + 1;
        }
        console.log(`\n[Review] By scope: ${Object.entries(byScope).map(([k, n]) => `${k} ${n}`).join(', ')}`);
        console.log(`[Review] By issue: ${Object.entries(byIssue).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}`);
        if (review.score != null) console.log(`[Review] The model's own score: ${review.score}/10.`);
        console.log('');
        for (const f of findings.slice(0, 15)) {
            console.log(`  [${f.scope} #${f.chunk + 1}] ${f.issue}: ${f.problem}`);
            if (f.advice) console.log(`      → ${f.advice}`);
        }
        if (findings.length > 15) console.log(`  … and ${findings.length - 15} more.`);
    }

    console.log(`\n[Review] Saved to ${reviewPath.split(/[\\/]/).pop()}. Nothing was changed — open the monitor to decide.`);
    console.log('--- SYSTEM: Translation review completed ---');
}
