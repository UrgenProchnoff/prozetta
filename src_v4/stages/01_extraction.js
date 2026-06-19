import { llmManager } from '../core/llm_client.js';
import { usageTracker } from '../core/usage_tracker.js';
import { HumanMessage } from "@langchain/core/messages";
import { extractJson } from '../utils/parsers.js';
import config from '../config.js';
import prompts from '../prompts.js';

export async function runExtractionStage(state) {
    console.log('--- SYSTEM: Starting Stage 1 (Extraction) ---');
    usageTracker.setStage('extraction');

    const chunks = state.getChunks();
    const client = llmManager.getClient('logic');
    const MAX_RETRIES = config.pipeline.extractionMaxRetries;

    let processedCount = 0;

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        // Skip if already successfully extracted (even if result is empty [])
        if (chunk.extraction_status === 'success') {
            continue;
        }

        console.log(`[Stage 1] Processing Chunk ${i + 1}/${chunks.length}...`);

        const prompt = prompts.extraction.system;

        const userMessage = prompts.extraction.user(chunk.original);

        let extracted = null;

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
                    console.warn(`[Stage 1] Empty response for chunk ${i}, attempt ${attempt}. Retrying...`);
                    continue;
                }

                // Try to parse JSON
                try {
                    const parsed = extractJson(content);
                    if (!Array.isArray(parsed)) {
                        console.warn(`[Stage 1] Parsed result is not an array for chunk ${i}, attempt ${attempt}. Retrying...`);
                        continue;
                    }
                    extracted = parsed;
                    break; // Success — exit retry loop

                } catch (e) {
                    console.warn(`[Stage 1] Failed to parse JSON for chunk ${i}, attempt ${attempt}: ${e.message}`);
                    continue;
                }

            } catch (error) {
                console.error(`[Stage 1] Error processing chunk ${i}, attempt ${attempt}: ${error.message}`);
                if (attempt >= MAX_RETRIES) {
                    throw error;
                }
            }
        }

        // Save result
        if (extracted !== null) {
            state.updateChunk(i, { extracted_terms: extracted, extraction_status: 'success' });
            if (extracted.length === 0) {
                console.log(`[Stage 1] Chunk ${i + 1}: no terms found (legitimate empty).`);
            } else {
                console.log(`[Stage 1] Chunk ${i + 1}: extracted ${extracted.length} terms.`);
            }
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
    console.log('--- SYSTEM: Stage 1 (Extraction) Completed ---');
}

