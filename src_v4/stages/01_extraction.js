import { llmManager } from '../core/llm_client.js';
import { usageTracker } from '../core/usage_tracker.js';
import { HumanMessage } from "@langchain/core/messages";
import { extractJson } from '../utils/parsers.js';
import config from '../config.js';
import { getPrompts } from '../prompts.js';

export async function runExtractionStage(state) {
    console.log('--- SYSTEM: Starting Stage 1 (Extraction) ---');
    usageTracker.setStage('extraction');

    const chunks = state.getChunks();
    const client = llmManager.getClient('logic');
    const MAX_RETRIES = config.pipeline.extractionMaxRetries;

    const targetLang = state.data.metadata?.targetLanguage || config.translation.targetLanguage;
    const prompts = getPrompts(config.translation.promptLang);
    const prompt = prompts.extraction.system(targetLang);

    let processedCount = 0;
    const blockedChunks = []; // 1-based numbers of chunks the content filter refused

    // A content-filter block is tied to the model that refused the text: when
    // the user switches provider/model (GUI settings or --model) and reruns
    // Stage 1, previously blocked chunks get another shot with the new model.
    const modelSignature = `${llmManager.provider}:${llmManager.getModelName()}`;

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        // Skip if already successfully extracted (even if result is empty [])
        // or refused by the content filter of this same model.
        if (chunk.extraction_status === 'success'
            || (chunk.extraction_status === 'blocked' && chunk.blocked_by === modelSignature)) {
            continue;
        }
        if (chunk.extraction_status === 'blocked') {
            console.log(`[Stage 1] Chunk ${i + 1} was blocked by "${chunk.blocked_by || 'unknown model'}" — retrying with "${modelSignature}"...`);
        }

        console.log(`[Stage 1] Processing Chunk ${i + 1}/${chunks.length}...`);

        const userMessage = prompts.extraction.user(chunk.original);

        let extracted = null;
        let blocked = false;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                console.log(`[Stage 1] Chunk ${i + 1}, attempt ${attempt}/${MAX_RETRIES}...`);
                const response = await client.invoke([
                    new HumanMessage(prompt),
                    new HumanMessage(userMessage)
                ]);

                const content = response.content;
                console.log('content=', content);

                // Check for empty/truncated response
                if (!content || content.trim().length === 0) {
                    console.warn(`[Stage 1] Empty response for chunk ${i + 1}, attempt ${attempt}. Retrying...`);
                    continue;
                }

                // Try to parse JSON
                try {
                    const parsed = extractJson(content);
                    if (!Array.isArray(parsed)) {
                        console.warn(`[Stage 1] Parsed result is not an array for chunk ${i + 1}, attempt ${attempt}. Retrying...`);
                        continue;
                    }
                    extracted = parsed;
                    break; // Success — exit retry loop

                } catch (e) {
                    console.warn(`[Stage 1] Failed to parse JSON for chunk ${i + 1}, attempt ${attempt}: ${e.message}`);
                    continue;
                }

            } catch (error) {
                console.error(`[Stage 1] Error processing chunk ${i + 1}, attempt ${attempt}: ${error.message}`);
                if (attempt >= MAX_RETRIES) {
                    // A content-filter block is permanent for this text: skip the
                    // chunk (no terms) instead of aborting the whole stage.
                    // Systemic errors (network, quota, bad key) still abort.
                    if (error.contentBlocked) {
                        blocked = true;
                        break;
                    }
                    throw error;
                }
            }
        }

        // Save result
        if (extracted !== null) {
            state.updateChunk(i, {
                extracted_terms: extracted,
                extraction_status: 'success',
                ...(chunk.blocked_by ? { blocked_by: null } : {})
            });
            if (extracted.length === 0) {
                console.log(`[Stage 1] Chunk ${i + 1}: no terms found (legitimate empty).`);
            } else {
                console.log(`[Stage 1] Chunk ${i + 1}: extracted ${extracted.length} terms.`);
            }
        } else if (blocked) {
            state.updateChunk(i, { extracted_terms: [], extraction_status: 'blocked', blocked_by: modelSignature });
            blockedChunks.push(i + 1);
            console.warn(`[Stage 1] Chunk ${i + 1}: BLOCKED by the provider's content filter — skipped, no terms extracted (see the error above).`);
        } else {
            console.warn(`[Stage 1] Chunk ${i + 1}: ALL ${MAX_RETRIES} extraction attempts failed. Will retry on next run.`);
            // Do NOT save extraction_status — chunk stays without it and gets retried
        }

        processedCount++;
        state.save();
        console.log(`[Stage 1] Saved progress.`);
        const usageLine = usageTracker.sessionLine();
        if (usageLine) console.log(usageLine);
    }

    state.save();
    if (blockedChunks.length > 0) {
        console.warn(`[Stage 1] WARNING: ${blockedChunks.length} chunk(s) were refused by the content filter and skipped: ${blockedChunks.join(', ')}. ` +
            `They are marked on the chunk map; their terms are missing from the glossary. ` +
            `To retry them, switch to another provider/model in the settings and rerun Stage 1 — new terms will be merged into the existing glossary.`);
    }
    console.log('--- SYSTEM: Stage 1 (Extraction) Completed ---');
}

