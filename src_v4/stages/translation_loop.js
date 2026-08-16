import fs from 'fs';
import { llmManager } from '../core/llm_client.js';
import { usageTracker } from '../core/usage_tracker.js';
import { HumanMessage } from "@langchain/core/messages";
import { extractFromTags, extractTagOptional, extractCheckResult } from '../utils/parsers.js';
import config from '../config.js';
import { getPrompts } from '../prompts.js';

export async function runTranslationLoopStage(state) {
    console.log('--- SYSTEM: Starting Stage 2 (Smart Translation Loop) ---');

    const targetLang = state.data.metadata?.targetLanguage || config.translation.targetLanguage;
    const prompts = getPrompts(config.translation.promptLang);

    const chunks = state.getChunks();
    const glossaryPath = state.getGlossaryPath();
    let glossary = [];

    if (fs.existsSync(glossaryPath)) {
        glossary = JSON.parse(fs.readFileSync(glossaryPath, 'utf-8'));
        console.log(`[Stage 2] Loaded glossary with ${glossary.length} terms.`);
    } else {
        console.warn('[Stage 2] No glossary found. Translation will proceed without it.');
    }

    const client = llmManager.getClient('logic'); // Only one model for V4

    let processedCount = 0;

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        // Skip if already finalized (success=true) or has good score
        if (chunk.translation && chunk.translation_status === 'success') {
            continue;
        }

        console.log(`[Stage 2] Processing Chunk ${i + 1}/${chunks.length}...`);

        let history = chunk.history || [];

        // 1. DRAFTING
        let currentTranslation = "";
        let currentComment = ""; // New field
        let globalContext = getLocalContextString(chunk.original, glossary);

        if (history.length === 0) {
            console.log(`   -> Drafting...`);
            const draft = await draftTranslation(client, prompts, targetLang, chunk.original, globalContext);
            currentTranslation = draft.translation;
            currentComment = draft.comment;
            console.log(`   [DEBUG] After draft: translation length=${currentTranslation?.length || 0}, first 100 chars: "${(currentTranslation || '').substring(0, 100)}"`);
            console.log(`   [DEBUG] After draft: comment="${currentComment}"`);

            history.push({
                step: 'draft',
                text: currentTranslation,
                translator_comment: currentComment,
                timestamp: new Date().toISOString()
            });

        } else {
            // Take the last text from history
            const lastItem = history[history.length - 1];
            currentTranslation = lastItem.text;
            currentComment = lastItem.translator_comment || "";
        }

        // 2. THE LOOP
        let attempts = 0;
        const MAX_RETRIES = config.pipeline.translationMaxRetries;
        const REDRAFT_SCORE_THRESHOLD = config.pipeline.redraftScoreThreshold;
        const APPROVAL_SCORE_THRESHOLD = config.pipeline.approvalScoreThreshold;
        let success = false;

        while (attempts < MAX_RETRIES && !success) {
            attempts++;
            console.log(`   -> Loop Iteration ${attempts} (Check)...`);

            console.log(`   [DEBUG] Before check: currentTranslation length=${currentTranslation?.length || 0}, first 100 chars: "${(currentTranslation || '').substring(0, 100)}"`);
            // CHECK
            const checkResult = await checkTranslation(client, prompts, targetLang, chunk.original, currentTranslation, globalContext, currentComment);
            history.push({
                step: `check_${attempts}`,
                result: checkResult,
                text: currentTranslation,
                translator_comment: currentComment,
                timestamp: new Date().toISOString()
            });

            // DECISION
            // success criteria from index10.js: !error && !misspell && correctness && like && (score >= 9.1 if not perfect)
            // if (successfully == 0 && dataJson.data.like && dataJson.data.score >= 9.1) successfully = 1;

            const isPerfect = (checkResult.error === 0 && checkResult.misspell === 0 && checkResult.correctness === 1 && checkResult.like === 1);
            let passed = isPerfect;

            if (!passed && checkResult.like === 1 && checkResult.score >= APPROVAL_SCORE_THRESHOLD) {
                passed = true;
            }

            if (passed) {
                console.log(`   -> APPROVED (Score: ${checkResult.score})`);
                success = true;
                state.updateChunk(i, {
                    translation: currentTranslation,
                    translation_status: 'success',
                    history: history
                });
            } else {
                // Break if max retries reached to avoid wasted fix/redraft
                if (attempts >= MAX_RETRIES) {
                    console.warn(`   -> Max retries reached.`);
                    break;
                }

                // Decide: FIX (доработка) vs REDRAFT (перевод заново)
                // Fix only if checker likes the direction AND score is above threshold
                // Otherwise retranslate from scratch — no point fixing a fundamentally broken translation
                const shouldFix = (checkResult.like === 1 && checkResult.score >= REDRAFT_SCORE_THRESHOLD);

                if (shouldFix) {
                    // Checker likes the direction, score is acceptable → FIX (доработка)
                    console.log(`   -> REJECTED for fixing (Score: ${checkResult.score}, Errors: ${checkResult.error}) | Reason: "${checkResult.comment}". Fixing...`);

                    const fixResult = await fixTranslation(client, prompts, targetLang, chunk.original, currentTranslation, globalContext, checkResult.comment);
                    currentTranslation = fixResult.translation;
                    currentComment = fixResult.comment;
                    console.log(`   [DEBUG] After fix: translation length=${currentTranslation?.length || 0}, first 100 chars: "${(currentTranslation || '').substring(0, 100)}"`);
                    console.log(`   [DEBUG] After fix: comment="${currentComment}"`);

                    history.push({
                        step: `fix_${attempts}`,
                        text: currentTranslation,
                        translator_comment: currentComment,
                        timestamp: new Date().toISOString()
                    });
                } else {
                    // Checker doesn't like it at all (like==0) → REDRAFT (перевод заново)
                    console.log(`   -> REJECTED for redraft (Score: ${checkResult.score}, Like: ${checkResult.like}) | Reason: "${checkResult.comment}". Retranslating from scratch...`);

                    const draft = await draftTranslation(client, prompts, targetLang, chunk.original, globalContext);
                    currentTranslation = draft.translation;
                    currentComment = draft.comment;
                    console.log(`   [DEBUG] After redraft: translation length=${currentTranslation?.length || 0}, first 100 chars: "${(currentTranslation || '').substring(0, 100)}"`);
                    console.log(`   [DEBUG] After redraft: comment="${currentComment}"`);

                    history.push({
                        step: `redraft_${attempts}`,
                        text: currentTranslation,
                        translator_comment: currentComment,
                        timestamp: new Date().toISOString()
                    });
                }

            }
        }

        if (!success) {
            // Find best version in history
            let bestScore = -1;
            let bestText = currentTranslation; // Default to the last attempted translation

            history.forEach(h => {
                if (h.result && h.result.score > bestScore && h.text) {
                    bestScore = h.result.score;
                    bestText = h.text;
                }
            });

            console.warn(`   -> Failed to reach perfection. Saving best effort (Score: ${bestScore}).`);

            state.updateChunk(i, {
                translation: bestText,
                translation_status: 'failed_best_effort',
                history: history
            });
        }

        processedCount++;
        state.save();
        console.log(`[Stage 2] Saved progress.`);
        const usageLine = usageTracker.sessionLine();
        if (usageLine) console.log(usageLine);
    }

    state.save();
    console.log('--- SYSTEM: Stage 2 (Translation Loop) Completed ---');
}

// --- HELPERS ---

// Substring matching turned nearly half the cheat sheet into noise: "HA" fired
// inside "charles", "M" inside "memory", "ICE" inside "noticed". Match on whole
// words instead — \b is useless here, it only knows [A-Za-z0-9_], so a Cyrillic
// or accented neighbour would still read as a boundary.
const WORD_CHAR = '[\\p{L}\\p{N}]';
const termRegexCache = new Map();

function wholeWordRegex(term) {
    let re = termRegexCache.get(term);
    if (!re) {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        re = new RegExp(`(?<!${WORD_CHAR})${escaped}(?!${WORD_CHAR})`, 'iu');
        termRegexCache.set(term, re);
    }
    return re;
}

function getLocalContextString(text, glossary) {
    const hits = [];
    glossary.forEach(term => {
        const original = String(term?.original || '').trim();
        if (!original) return;
        if (wholeWordRegex(original).test(text)) {
            hits.push(`${original} -> ${term.translation}`);
        }
    });
    return hits.join('\n');
}


// --- LLM FUNCTIONS (Prompts from index10.js) ---

// How many times to re-ask when the answer comes back without a <translate> tag.
const MISSING_TAG_RETRIES = 2;

/**
 * Run a translate/fix call and pull the <translate> tag out of the answer.
 * A missing tag means the model ignored the output format and the response is
 * its preamble or reasoning — re-ask instead of pasting that into the book.
 * If it keeps ignoring the format, hand the raw text back so the review loop
 * can score it and redraft, as it did before.
 */
async function invokeForTranslation(client, label, messages) {
    let content = '';
    for (let attempt = 1; attempt <= MISSING_TAG_RETRIES + 1; attempt++) {
        const response = await client.invoke(messages);
        content = response.content || '';
        const translation = extractFromTags(content, 'translate');
        if (translation !== null) {
            return { translation, comment: extractTagOptional(content, 'comment') };
        }
        console.warn(`   [WARN] ${label}: answer has no <translate> tag (attempt ${attempt}/${MISSING_TAG_RETRIES + 1}).`);
    }
    console.warn(`   [WARN] ${label}: still no <translate> tag — passing the raw answer to review.`);
    return { translation: content.trim(), comment: extractTagOptional(content, 'comment') };
}

async function draftTranslation(client, prompts, targetLang, original, context) {
    usageTracker.setStage('translate');
    const input = prompts.draft.user(original, context);
    const prompt = prompts.draft.system(targetLang);

    return invokeForTranslation(client, 'draft', [
        new HumanMessage(prompt),
        new HumanMessage(input)
    ]);
}

async function checkTranslation(client, prompts, targetLang, original, translation, context, translatorComment) {
    usageTracker.setStage('check');
    const input = prompts.check.user(context, original, translation, translatorComment);

    const prompt = prompts.check.system(targetLang);

    const response = await client.invoke([
        new HumanMessage(prompt),
        new HumanMessage(input)
    ]);
    //console.log("check tr input=", input);
    //console.log("check tr prompt=", prompt);
    //console.log("check tr response=", response.content);

    // Normalize keys just in case
    return extractCheckResult(response.content);
}

async function fixTranslation(client, prompts, targetLang, original, badTranslation, context, comment) {
    usageTracker.setStage('fix');
    const input = prompts.fix.user(original, context, badTranslation, comment);

    const prompt = prompts.fix.system(targetLang);

    return invokeForTranslation(client, 'fix', [
        new HumanMessage(prompt),
        new HumanMessage(input)
    ]);
}
