/**
 * Review the finished translation — one call, findings only.
 *
 * Nothing here changes a chunk. The stage writes translation_review.json; the
 * monitor shows the findings beside the chunks they name, and a human decides
 * which become work. The same rule the glossary review follows, for the same
 * reason: every finding is a judgement about a book, and there is no class of
 * them that cannot be wrong.
 *
 * The stage is in two halves — build the prompt, apply the answer — with the
 * call between them. Split that way because the call is the one part a person
 * may have to make by hand: see core/book_call.js. Both routes share the halves,
 * so a hand-carried answer is verified exactly as an API one is.
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
import { fingerprint, fingerprintMismatch } from '../core/book_call.js';
import config from '../config.js';
import { getPrompts } from '../prompts.js';

// What a free tier accepts in one minute. The context window is not the binding
// constraint — measured on Gemini's free tier, tokens per minute is, and it
// refuses the call outright rather than truncating.
const TOKEN_BUDGET = config.pipeline.bookCallTokenBudget || 170000;

/**
 * Everything the reviewer is to be given, and what it adds up to.
 *
 * @param {ProjectState} state
 * @param {{withOriginal?: boolean}} options
 *   `withOriginal` pairs each chunk's source text with its translation, so the
 *   reviewer can judge meaning and not only the Russian. It roughly doubles the
 *   prompt and is therefore only for the manual route — see core/book_call.js.
 * @returns {{system: string, user: string, tokens: object, fingerprint: string,
 *            warnings: string[]}}
 * @throws {Error} when there is nothing to review
 */
export function buildTranslationReviewPrompt(state, { withOriginal = false } = {}) {
    const chunks = state.getChunks();
    const translated = chunks.filter(c => c.translation);
    if (!translated.length) throw new Error('Nothing is translated yet — there is nothing to review.');

    const warnings = [];
    if (translated.length < chunks.length) {
        warnings.push(`Only ${translated.length} of ${chunks.length} chunks are translated. The review will read ` +
            `a book with holes in it, and may report a break in style that is really a gap.`);
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
            warnings.push(`Could not read the glossary (${e.message}) — reviewing without it.`);
        }
    }

    // The decisions the book was translated under. Without them the reviewer has
    // to infer the intent from the text, which makes the majority right by
    // definition — and leaves it unable to route its own findings: it is asked to
    // send some to the passport while never having seen it, so it cannot tell
    // "the passport says nothing about this" from "the passport says it and this
    // chunk disobeyed", which are different repairs.
    //
    // The point-of-view map is left out. It is written in chunk indices, and the
    // reviewer is given text with no chunk numbering it can rely on.
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

    // Bilingually the two texts are interleaved rather than stacked: aligning
    // 169 chunks of one against 169 of the other is work the model would have to
    // do before it could compare anything, and getting it wrong would turn every
    // comparison into noise. Alignment is a fact we have; there is no reason to
    // make it a question.
    const body = withOriginal
        ? chunks.filter(c => c.translation).map((c, i) =>
            `<pair n="${i + 1}">\n<src>${c.original || ''}</src>\n<dst>${c.translation}</dst>\n</pair>`).join('\n\n')
        : chunks.map(c => c.translation || '').filter(Boolean).join('\n');

    const targetLang = state.data.metadata?.targetLanguage || config.translation.targetLanguage;
    const prompts = getPrompts(config.translation.promptLang);
    const system = prompts.translationReview.system(targetLang, withOriginal);
    const user = prompts.translationReview.user(body, pairs, intent, withOriginal);

    const tokens = {
        text: countTokens(body),
        glossary: pairs.length ? countTokens(JSON.stringify(pairs)) : 0,
        passport: intent ? countTokens(JSON.stringify(intent)) : 0,
        instructions: countTokens(system),
    };
    tokens.total = tokens.text + tokens.glossary + tokens.passport + tokens.instructions;

    return {
        system,
        user,
        tokens,
        withOriginal,
        budget: TOKEN_BUDGET,
        // Over the translation only: that is what the quotes are taken from, and
        // what has to still be there when the answer comes back.
        fingerprint: fingerprint(chunks.map(c => c.translation || '').join('\n')),
        warnings,
    };
}

/**
 * Verify an answer and record it, whoever obtained it.
 *
 * @param {ProjectState} state
 * @param {*} raw               the parsed answer
 * @param {{model: string, source: 'api'|'manual', fingerprint?: string,
 *           withOriginal?: boolean, answerText?: string}} meta
 *   `answerText` is the reply as it arrived. Kept so that a missing score or
 *   summary can be told from a model that never sent one — the first real manual
 *   review lost both to a parser that took the findings array out of the object
 *   wrapping it, and nothing on disk could say which had happened.
 * @returns {{review: object, findings: Array, rejected: object, notes: string[]}}
 * @throws {Error} when the answer does not belong to this text, or nothing in it survives
 */
export function applyTranslationReview(state, raw, meta) {
    const chunks = state.getChunks();
    const notes = [];

    const stale = fingerprintMismatch(fingerprint(chunks.map(c => c.translation || '').join('\n')), meta.fingerprint);
    if (stale) throw new Error(stale);

    // A rerun overwrites the file, so decisions made about the previous findings
    // have to be carried across first. Keyed by what a finding says rather than
    // where it sat, so a model that repeats itself stays dismissed.
    const reviewPath = state.getTranslationReviewPath();
    let carriedDismissals = [];
    if (fs.existsSync(reviewPath)) {
        try {
            const previous = JSON.parse(fs.readFileSync(reviewPath, 'utf-8'));
            carriedDismissals = Array.isArray(previous.dismissed) ? previous.dismissed : [];
            if (carriedDismissals.length) notes.push(`Carrying over ${carriedDismissals.length} finding(s) you had dismissed.`);
        } catch { /* an unreadable previous review must not block a new one */ }
    }

    const list = Array.isArray(raw?.findings) ? raw.findings : (Array.isArray(raw) ? raw : []);
    const { findings, rejected, rejectedFindings } = verifyFindings(list, chunks);

    // An answer that was not empty but survived nothing is a pasted mistake far
    // more often than a book with nothing wrong in it, and overwriting the last
    // review with it would destroy work to record a typo.
    if (list.length && !findings.length) {
        throw new Error(`All ${list.length} finding(s) in this answer failed verification ` +
            `(${JSON.stringify(rejected)}). Nothing was saved — the previous review is untouched. ` +
            `Check that the whole answer was pasted, and that it is the answer to this book's prompt.`);
    }

    const score = Number(raw?.score);
    const review = {
        generatedAt: new Date().toISOString(),
        model: meta.model || null,
        // How the answer was obtained. The file used to say which model the stage
        // called, which is a lie about one a person carried by hand.
        source: meta.source || 'api',
        bilingual: !!meta.withOriginal,
        chunks: chunks.length,
        translated: chunks.filter(c => c.translation).length,
        returned: list.length,
        // The model's opinion, stored as one. Measured across five books, the
        // per-chunk reviewer's score has a median of 10 and never falls below 9,
        // so a number from a single call is not a metric and must not be shown as
        // though it were comparable between runs. The findings are.
        score: Number.isFinite(score) ? score : null,
        // The prose around the JSON, when the JSON carries none. A model asked
        // for an overall verdict often writes it as text and puts only the
        // findings in the block; that verdict is what was asked for, and throwing
        // it away because of where it was written would be pedantry.
        summary: String(raw?.summary || '').trim() || proseAround(meta.answerText) || null,
        dismissed: carriedDismissals,
        rejected,
        findings,
        // Deliberately last and under a name nothing else reads: these failed
        // verification and must not be one careless join away from the interface.
        rejectedFindings,
        // The answer as it arrived, so what is missing here can be checked
        // against what was actually sent. Capped: a reply is tens of kilobytes
        // and a runaway one should not become the largest file in the project.
        rawAnswer: meta.answerText ? String(meta.answerText).slice(0, 400000) : undefined,
    };
    fs.writeFileSync(reviewPath, JSON.stringify(review, null, 2));
    return { review, findings, rejected, notes };
}


/**
 * The text a reply carries outside its JSON — an answer's own words about the
 * book, when it wrote them as prose instead of putting them in the object.
 */
function proseAround(text) {
    if (!text) return '';
    const stripped = String(text)
        .replace(/```json[\s\S]*?```/g, ' ')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/\{[\s\S]*\}/, ' ')
        .replace(/\[[\s\S]*\]/, ' ')
        .trim();
    return stripped.length >= 40 ? stripped.slice(0, 4000) : '';
}

export async function runTranslationReviewStage(state) {
    console.log('--- SYSTEM: Reviewing the finished translation ---');
    usageTracker.setStage('translation_review');

    if (!bookModelEnabled()) {
        console.error('[Review] The large model is switched off (book_model.enabled), and this pass is nothing but ' +
            'one call to it. Turn it on in Settings → Large model.');
        process.exitCode = 1;
        return;
    }

    let built;
    try {
        built = buildTranslationReviewPrompt(state);
    } catch (e) {
        console.error(`[Review] ${e.message}`);
        process.exitCode = 1;
        return;
    }
    for (const w of built.warnings) console.warn(`[Review] ${w}`);

    const t = built.tokens;
    const fmt = n => n.toLocaleString('en-US');
    console.log(`[Review] Prompt: ~${fmt(t.text)} tokens of translation + ~${fmt(t.glossary)} of glossary` +
        `${t.passport ? ` + ~${fmt(t.passport)} of passport` : ''} + ~${fmt(t.instructions)} of instructions = ~${fmt(t.total)}.`);

    if (t.total > TOKEN_BUDGET) {
        console.error(`\n[Review] TOO LARGE: ~${fmt(t.total)} tokens against a budget of ${fmt(TOKEN_BUDGET)}.`);
        console.error(`[Review] The translation has to be sent whole: half a book cannot show that a term is`);
        console.error(`[Review] rendered two ways or that a voice drifts, which is the entire point of this pass.`);
        console.error(`[Review] What refuses a call this size is a per-minute quota on INPUT alone, which is`);
        console.error(`[Review] lower than the documented total.`);
        console.error(`[Review] Either raise pipeline.bookCallTokenBudget for a paid tier, or take the prompt to a`);
        console.error(`[Review] web console by hand — the monitor offers that, and it can carry the original too.\n`);
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
            new HumanMessage(built.system),
            new HumanMessage(built.user),
        ]);
        raw = extractJson(response.content || '');
    } catch (e) {
        console.error(`[Review] The whole-book call failed — ${explainCallFailure(e, provider, conf)}`);
        if (e.contentBlocked) {
            console.error('[Review] The provider refused the text. Retrying will not help — switch the book_model provider.');
        }
        if (e.oversizedPrompt) {
            console.error('[Review] The monitor can hand you this prompt to run in a web console instead.');
        }
        process.exitCode = 1;
        return;
    }

    let applied;
    try {
        applied = applyTranslationReview(state, raw, {
            model: conf.modelName, source: 'api', fingerprint: built.fingerprint,
        });
    } catch (e) {
        console.error(`[Review] ${e.message}`);
        process.exitCode = 1;
        return;
    }
    for (const n of applied.notes) console.log(`[Review] ${n}`);

    const { findings, rejected, review } = applied;
    const dropped = Object.values(rejected).reduce((a, b) => a + b, 0);
    console.log(`[Review] ${review.returned} finding(s) returned, ${findings.length} passed verification` +
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

    reportFindings(findings, review);
    console.log(`\n[Review] Saved to ${state.getTranslationReviewPath().split(/[\\/]/).pop()}. ` +
        `Nothing was changed — open the monitor to decide.`);
    console.log('--- SYSTEM: Translation review completed ---');
}

function reportFindings(findings, review) {
    if (!findings.length) return;
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
