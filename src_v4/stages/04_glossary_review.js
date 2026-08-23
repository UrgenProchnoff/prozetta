/**
 * Review the glossary against the whole book — one call, findings only.
 *
 * Nothing here changes the glossary. The stage writes
 * <prefix>_glossary_review.json, which the editor shows next to the rows it
 * concerns, and a human decides. That is the same rule the deterministic hygiene
 * pass follows: apply what cannot be wrong, report the rest. The model has no
 * findings of the first kind — every one of them is a judgement about a book.
 *
 * The reasoning behind the evidence and the verification contract is in
 * core/glossary_review.js.
 */

import fs from 'fs';
import { HumanMessage } from '@langchain/core/messages';
import { llmManager, bookModelEnabled, explainCallFailure } from '../core/llm_client.js';
import { usageTracker } from '../core/usage_tracker.js';
import { extractJson } from '../utils/parsers.js';
import { countTokens, chunkTokens } from '../core/tokenizer.js';
import { glossaryEvidence, verifyFindings } from '../core/glossary_review.js';
import { fingerprint, fingerprintMismatch } from '../core/book_call.js';
import config from '../config.js';
import { getPrompts } from '../prompts.js';

// What a free tier will accept in one minute (config.pipeline.bookCallTokenBudget).
// The context window is not the binding constraint — measured on Gemini's free
// tier, tokens per minute is, and it refuses the call outright rather than
// truncating.
const TOKEN_BUDGET = config.pipeline.bookCallTokenBudget || 250000;

/**
 * Everything the reviewer is to be given, and what it adds up to.
 *
 * Split out so the call between building and applying can be made by hand when a
 * provider refuses one this size — see core/book_call.js. Both routes share the
 * halves, so an answer carried from a web console is verified exactly as an API
 * one is.
 *
 * @throws {Error} when there is no glossary to review
 */
export function buildGlossaryReviewPrompt(state) {
    const chunks = state.getChunks();
    if (!chunks.length) throw new Error('Project has no chunks yet — run Stage 1 first.');

    const glossaryPath = state.getGlossaryPath();
    if (!fs.existsSync(glossaryPath)) throw new Error(`No glossary to review: ${glossaryPath}`);
    let glossary;
    try {
        glossary = JSON.parse(fs.readFileSync(glossaryPath, 'utf-8'));
    } catch (e) {
        throw new Error(`Could not read the glossary: ${e.message}`);
    }
    if (!Array.isArray(glossary) || !glossary.length) throw new Error('The glossary is empty — nothing to review.');

    const bookText = chunks.map(c => c.original).join('\n');
    const targetLang = state.data.metadata?.targetLanguage || config.translation.targetLanguage;
    const prompts = getPrompts(config.translation.promptLang);
    const evidence = glossaryEvidence(glossary, bookText);

    const system = prompts.glossaryReview.system(targetLang);
    const user = prompts.glossaryReview.user(bookText, evidence);

    // Both halves have to be sent whole — a review of half a glossary cannot see
    // that one person occupies two entries, which is the point of the exercise.
    const tokens = {
        book: chunkTokens(chunks),
        glossary: countTokens(JSON.stringify(evidence, null, 0)),
        instructions: countTokens(system),
    };
    tokens.total = tokens.book + tokens.glossary + tokens.instructions;

    return {
        system, user, tokens,
        budget: TOKEN_BUDGET,
        entries: glossary.length,
        // Over the glossary: the findings name its entries, and an answer made
        // from a different version of it would point at rows that have moved.
        fingerprint: fingerprint(JSON.stringify(glossary)),
        warnings: [],
    };
}

/**
 * Verify an answer and record it, whoever obtained it.
 *
 * @throws {Error} when the answer does not belong to this glossary
 */
export function applyGlossaryReview(state, raw, meta) {
    const notes = [];
    const glossary = JSON.parse(fs.readFileSync(state.getGlossaryPath(), 'utf-8'));
    const bookText = state.getChunks().map(c => c.original).join('\n');

    const stale = fingerprintMismatch(fingerprint(JSON.stringify(glossary)), meta.fingerprint);
    if (stale) throw new Error(stale);

    const reviewPath = state.getGlossaryReviewPath();
    let carriedDismissals = [];
    if (fs.existsSync(reviewPath)) {
        try {
            const previous = JSON.parse(fs.readFileSync(reviewPath, 'utf-8'));
            carriedDismissals = Array.isArray(previous.dismissed) ? previous.dismissed : [];
            if (carriedDismissals.length) notes.push(`Carrying over ${carriedDismissals.length} finding(s) you had dismissed.`);
        } catch { /* an unreadable previous review must not block a new one */ }
    }

    // Some models wrap the array in an object however firmly the format is stated.
    const list = Array.isArray(raw) ? raw : (raw?.findings || raw?.results || []);
    const { findings, rejected, rejectedFindings } = verifyFindings(list, glossary, bookText);

    if (list.length && !findings.length) {
        throw new Error(`All ${list.length} finding(s) in this answer failed verification ` +
            `(${JSON.stringify(rejected)}). Nothing was saved — the previous review is untouched.`);
    }

    const review = {
        generatedAt: new Date().toISOString(),
        model: meta.model || null,
        source: meta.source || 'api',
        glossarySize: glossary.length,
        returned: list.length,
        dismissed: carriedDismissals,
        rejected,
        findings,
        // Deliberately last, and deliberately under a name nothing else reads:
        // these failed verification and must not be one careless join away from
        // the editor.
        rejectedFindings,
        rawAnswer: meta.answerText ? String(meta.answerText).slice(0, 400000) : undefined,
    };
    fs.writeFileSync(reviewPath, JSON.stringify(review, null, 2));
    return { review, findings, rejected, notes };
}

export async function runGlossaryReviewStage(state) {
    console.log('--- SYSTEM: Reviewing the glossary against the book ---');
    usageTracker.setStage('glossary_review');

    if (!bookModelEnabled()) {
        console.error('[Review] The large model is switched off (book_model.enabled), and this pass is nothing but ' +
            'one call to it. Turn it on in Settings → Large model.');
        process.exitCode = 1;
        return;
    }

    let built;
    try {
        console.log('[Review] Counting occurrences for the glossary...');
        built = buildGlossaryReviewPrompt(state);
    } catch (e) {
        console.error(`[Review] ${e.message}`);
        process.exitCode = 1;
        return;
    }

    const t = built.tokens;
    const fmt = n => n.toLocaleString('en-US');
    console.log(`[Review] Prompt: ~${fmt(t.book)} tokens of book + ~${fmt(t.glossary)} of glossary + ` +
        `~${fmt(t.instructions)} of instructions = ~${fmt(t.total)}.`);

    if (t.total > TOKEN_BUDGET) {
        console.error(`\n[Review] TOO LARGE: ~${fmt(t.total)} tokens against a budget of ${fmt(TOKEN_BUDGET)}.`);
        console.error(`[Review] The book (${fmt(t.book)}) and the glossary (${fmt(t.glossary)}) both have to be sent whole:`);
        console.error(`[Review] half a glossary cannot show that one character occupies two entries, and`);
        console.error(`[Review] half a book cannot show how a term is actually used. Splitting would not review, it would guess.`);
        console.error(`[Review] Either raise the limit for a paid tier, or take the prompt to a web console by hand —`);
        console.error(`[Review] the glossary editor offers that.\n`);
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
    console.log(`[Review] Asking ${conf.modelName} to review the glossary against the whole book...`);

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
            console.error('[Review] The glossary editor can hand you this prompt to run in a web console instead.');
        }
        process.exitCode = 1;
        return;
    }

    let applied;
    try {
        applied = applyGlossaryReview(state, raw, {
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
            malformed: 'malformed', unknownEntry: 'no such glossary entry', badQuote: 'quote not in the book',
            absentOriginal: 'proposed a form the book never uses', unknownTarget: 'merge target does not exist',
            emptyFix: 'nothing would change',
        };
        for (const [key, n] of Object.entries(rejected)) {
            if (n) console.log(`[Review]   ${n} × ${names[key]}`);
        }
    }
    if (rejected.badQuote) {
        console.log(`[Review] Note: a quote that cannot be found means the model wrote from memory rather than ` +
            `from the text in front of it. Those findings are unverifiable, so they are not applied.`);
    }
    if (dropped) {
        console.log(`[Review] The dropped findings are kept in "rejectedFindings" with the check each failed. ` +
            `Nothing reads that field — it is there so the question of how far an unverified finding can be ` +
            `trusted can be answered from accumulated runs rather than guessed at.`);
    }

    const byAction = {}, byIssue = {};
    for (const f of findings) {
        byAction[f.action] = (byAction[f.action] || 0) + 1;
        byIssue[f.issue] = (byIssue[f.issue] || 0) + 1;
    }
    if (findings.length) {
        console.log(`\n[Review] By action:  ${Object.entries(byAction).map(([k, n]) => `${k} ${n}`).join(', ')}`);
        console.log(`[Review] By issue:   ${Object.entries(byIssue).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}\n`);
        for (const f of findings.slice(0, 15)) {
            const to = f.mergeInto ? ` → «${f.mergeInto}»` : '';
            console.log(`  [${f.action}] ${f.entry || f.fix?.original || '—'}${to}: ${f.problem}`);
            if (f.fix) {
                for (const [field, value] of Object.entries(f.fix)) {
                    console.log(`      ${field}: ${String(value).slice(0, 100)}`);
                }
            }
        }
        if (findings.length > 15) console.log(`  … and ${findings.length - 15} more.`);
    }

    console.log(`\n[Review] Saved to ${state.getGlossaryReviewPath().split(/[\\/]/).pop()}. ` +
        `Nothing was applied — open the glossary editor to decide.`);
    console.log('--- SYSTEM: Glossary review completed ---');
}
