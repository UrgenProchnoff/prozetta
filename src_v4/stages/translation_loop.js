import fs from 'fs';
import { llmManager } from '../core/llm_client.js';
import { HumanMessage } from "@langchain/core/messages";
import { extractFromTags, extractTagOptional, extractCheckResult } from '../utils/parsers.js';
import config from '../config.js';
import prompts from '../prompts.js';

export async function runTranslationLoopStage(state) {
    console.log('--- SYSTEM: Starting Stage 2 (Smart Translation Loop) ---');

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
            const draft = await draftTranslation(client, chunk.original, globalContext);
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
            const checkResult = await checkTranslation(client, chunk.original, currentTranslation, globalContext, currentComment);
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

                    const fixResult = await fixTranslation(client, chunk.original, currentTranslation, globalContext, checkResult.comment);
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

                    const draft = await draftTranslation(client, chunk.original, globalContext);
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
    }

    state.save();
    console.log('--- SYSTEM: Stage 2 (Translation Loop) Completed ---');
}

// --- HELPERS ---

function getLocalContextString(text, glossary) {
    const hits = [];
    const lowerText = text.toLowerCase();
    glossary.forEach(term => {
        if (lowerText.includes(term.original.toLowerCase())) {
            hits.push(`${term.original} -> ${term.translation}`);
        }
    });
    return hits.join('\n');
}


// --- LLM FUNCTIONS (Prompts from index10.js) ---

async function draftTranslation(client, original, context) {
    const input = prompts.draft.user(original, context);
    const prompt = prompts.draft.system;

    //console.log("draft tr prompt=", prompt);
    //console.log("draft tr input=", input);
    const response = await client.invoke([
        new HumanMessage(prompt),
        new HumanMessage(input)
    ]);
    //console.log("draft response=", response.content);
    return {
        translation: extractFromTags(response.content, 'translate'),
        comment: extractTagOptional(response.content, 'comment')
    };
}

async function checkTranslation(client, original, translation, context, translatorComment) {
    const input = prompts.check.user(context, original, translation, translatorComment);

    const prompt = prompts.check.system;

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

async function fixTranslation(client, original, badTranslation, context, comment) {
    const input = prompts.fix.user(original, context, badTranslation, comment);

    const prompt = prompts.fix.system;

    const response = await client.invoke([
        new HumanMessage(prompt),
        new HumanMessage(input)
    ]);
    //    console.log("fix tr input=", input);
    //    console.log("fix tr prompt=", prompt);
    console.log("fix tr response content type=", typeof response.content);
    console.log("fix tr response content=", JSON.stringify(response.content));
    console.log("fix tr response keys=", Object.keys(response));
    if (response.additional_kwargs) console.log("fix tr additional_kwargs=", JSON.stringify(response.additional_kwargs));
    if (response.response_metadata) console.log("fix tr response_metadata=", JSON.stringify(response.response_metadata));

    // Handle case where content might be an array (multi-part response)
    let content = response.content;
    if (Array.isArray(content)) {
        console.log("fix tr: content is ARRAY, extracting text parts...");
        content = content
            .filter(part => part.type === 'text')
            .map(part => part.text)
            .join('');
    }
    content = content || '';

    return {
        translation: extractFromTags(content, 'translate'),
        comment: extractTagOptional(content, 'comment')
    };
}
