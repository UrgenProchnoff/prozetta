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
import { llmManager } from '../core/llm_client.js';
import { usageTracker } from '../core/usage_tracker.js';
import { extractJson } from '../utils/parsers.js';
import { countTokens } from '../core/tokenizer.js';
import { glossaryEvidence, verifyFindings } from '../core/glossary_review.js';
import config from '../config.js';
import { getPrompts } from '../prompts.js';

// What a free tier will accept in one minute (config.pipeline.bookCallTokenBudget).
// The context window is not the binding constraint — measured on Gemini's free
// tier, tokens per minute is, and it refuses the call outright rather than
// truncating.
const TOKEN_BUDGET = config.pipeline.bookCallTokenBudget || 250000;

export async function runGlossaryReviewStage(state) {
    console.log('--- SYSTEM: Reviewing the glossary against the book ---');
    usageTracker.setStage('glossary_review');

    const chunks = state.getChunks();
    if (!chunks.length) {
        console.error('[Review] Project has no chunks yet — run Stage 1 first.');
        process.exitCode = 1;
        return;
    }

    const glossaryPath = state.getGlossaryPath();
    if (!fs.existsSync(glossaryPath)) {
        console.error(`[Review] No glossary to review: ${glossaryPath}`);
        process.exitCode = 1;
        return;
    }
    let glossary;
    try {
        glossary = JSON.parse(fs.readFileSync(glossaryPath, 'utf-8'));
    } catch (e) {
        console.error(`[Review] Could not read the glossary: ${e.message}`);
        process.exitCode = 1;
        return;
    }
    if (!Array.isArray(glossary) || !glossary.length) {
        console.error('[Review] The glossary is empty — nothing to review.');
        process.exitCode = 1;
        return;
    }

    // A rerun overwrites the review file, so anything a person decided about the
    // previous one has to be carried across first. Dismissals are keyed by what
    // the finding says rather than where it sat, so a model that repeats itself
    // stays dismissed.
    const reviewPath = state.getGlossaryReviewPath();
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

    const bookText = chunks.map(c => c.original).join('\n');
    const targetLang = state.data.metadata?.targetLanguage || config.translation.targetLanguage;
    const prompts = getPrompts(config.translation.promptLang);

    console.log(`[Review] Counting occurrences for ${glossary.length} entries...`);
    const evidence = glossaryEvidence(glossary, bookText);

    // --- does it fit? ---
    // Chunks carry real token counts from the splitter; the glossary block is
    // measured with the same tokenizer. Both halves have to be sent whole — a
    // review of half a glossary cannot see that one person occupies two entries,
    // which is the point of the exercise.
    const bookTokens = chunks.reduce((n, c) => n + (c.tokens || Math.round(c.original.length / 4)), 0);
    const glossaryTokens = countTokens(JSON.stringify(evidence, null, 0));
    const total = bookTokens + glossaryTokens;
    const fmt = n => n.toLocaleString('en-US');
    console.log(`[Review] Prompt: ~${fmt(bookTokens)} tokens of book + ~${fmt(glossaryTokens)} of glossary = ~${fmt(total)}.`);

    if (total > TOKEN_BUDGET) {
        console.error(`\n[Review] TOO LARGE: ~${fmt(total)} tokens against a budget of ${fmt(TOKEN_BUDGET)}.`);
        console.error(`[Review] The book (${fmt(bookTokens)}) and the glossary (${fmt(glossaryTokens)}) both have to be sent whole:`);
        console.error(`[Review] half a glossary cannot show that one character occupies two entries, and`);
        console.error(`[Review] half a book cannot show how a term is actually used. Splitting would not review, it would guess.`);
        console.error(`[Review] Either raise the limit for a paid tier, or review this book's glossary by hand.\n`);
        process.exitCode = 1;
        return;
    }

    const client = llmManager.getClient('book');
    const { conf } = llmManager.getBookSettings();
    console.log(`[Review] Asking ${conf.modelName} to review the glossary against the whole book...`);

    let raw;
    try {
        const response = await client.invoke([
            new HumanMessage(prompts.glossaryReview.system(targetLang)),
            new HumanMessage(prompts.glossaryReview.user(bookText, evidence)),
        ]);
        raw = extractJson(response.content || '');
    } catch (e) {
        console.error(`[Review] The whole-book call failed: ${e.message}`);
        if (e.contentBlocked) {
            console.error('[Review] The provider refused the text. Retrying will not help — switch the book_model provider.');
        }
        process.exitCode = 1;
        return;
    }

    // Some models wrap the array in an object however firmly the format is stated.
    const list = Array.isArray(raw) ? raw : (raw?.findings || raw?.results || []);
    const { findings, rejected, rejectedFindings } = verifyFindings(list, glossary, bookText);

    const dropped = Object.values(rejected).reduce((a, b) => a + b, 0);
    console.log(`[Review] ${list.length} finding(s) returned, ${findings.length} passed verification` +
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

    const review = {
        generatedAt: new Date().toISOString(),
        model: conf.modelName,
        glossarySize: glossary.length,
        returned: list.length,
        // Findings a person has judged wrong, by findingKey. The editor writes
        // here, and a rerun carries the list over — an entry defended once should
        // not have to be defended again just because the review was repeated.
        dismissed: carriedDismissals,
        rejected,
        findings,
        // Deliberately last, and deliberately under a name nothing else reads:
        // these failed verification and must not be one careless join away from
        // the editor. Should they ever be shown, it has to be as a separate,
        // marked thing — never mixed into the verified list.
        rejectedFindings,
    };
    fs.writeFileSync(reviewPath, JSON.stringify(review, null, 2));

    // --- report ---
    const byAction = {};
    const byIssue = {};
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

    console.log(`\n[Review] Saved to ${reviewPath.split(/[\\/]/).pop()}. Nothing was applied — open the glossary editor to decide.`);
    console.log('--- SYSTEM: Glossary review completed ---');
}
