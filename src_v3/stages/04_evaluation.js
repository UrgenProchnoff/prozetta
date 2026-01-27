import fs from 'fs';
import path from 'path';
import { llmManager } from '../core/llm_client.js';
import { HumanMessage } from "@langchain/core/messages";

export async function runEvaluationStage(state) {
    console.log('--- SYSTEM: Starting Stage 3 (Evaluation & Assembly) ---');

    const chunks = state.getChunks();
    const client = llmManager.getClient('logic'); // Qwen3 for brains

    let processedCount = 0;

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        // Skip if no variants
        if (!chunk.variants || chunk.variants.length === 0) {
            console.warn(`[Stage 3] Chunk ${i} has no variants. Skipping.`);
            continue;
        }

        // If already evaluated, skip re-eval (unless forced?)
        if (chunk.evaluation && chunk.evaluation.best_index !== undefined) {
            // We can proceed to next, or maybe we want to re-assemble? 
            // Logic: keep iterating to ensure we cover all, then assemble at the end.
            continue;
        }

        console.log(`[Stage 3] Evaluating Chunk ${i + 1}/${chunks.length}...`);

        const prompt = `
        Ты - профессиональный литературный редактор. 
        Твоя задача - выбрать ЛУЧШИЙ из трех вариантов перевода.
        
        Критерии:
        1. Точность (смысл передан верно).
        2. Художественность (звучит естественно на русском).
        3. Отсутствие галлюцинаций (нет отсебятины).

        Оригинал:
        ${chunk.original}

        Вариант 1:
        ${chunk.variants[0]}

        Вариант 2:
        ${chunk.variants[1]}

        Вариант 3:
        ${chunk.variants[2]}

        Выбери лучший вариант (0, 1 или 2). Поставь оценки (0-10).
        Рассуждай по шагам.
        Окончательный ответ в формате JSON:
        {
          "scores": [8.5, 9.0, 7.0],
          "best_index": 1,
          "reason": "Вариант 2 наиболее точно передает стиль, варианты 1 и 3 суховаты."
        }
        `;

        let retries = 2;
        let success = false;

        while (retries > 0 && !success) {
            try {
                const response = await client.invoke([
                    new HumanMessage(prompt)
                ]);

                const content = response.content.replace(/```json/g, '').replace(/```/g, '').trim();
                const evalResult = JSON.parse(content);

                // Validate structure
                if (evalResult.best_index !== undefined && Array.isArray(evalResult.scores)) {
                    state.updateChunk(i, { evaluation: evalResult });
                    success = true;
                } else {
                    throw new Error("Invalid JSON structure");
                }

            } catch (e) {
                console.error(`[Stage 3] Eval failed for chunk ${i}: ${e.message}`);
                retries--;
                if (retries === 0) {
                    // Fallback: Pick default (e.g. 0 - or the one with middle temp)
                    state.updateChunk(i, { evaluation: { best_index: 1, scores: [], reason: "Fallback due to eval error" } });
                }
            }
        }

        processedCount++;
        if (processedCount % 5 === 0) {
            state.save();
            console.log(`[Stage 3] Saved progress.`);
        }
    }
    state.save();

    console.log('[Stage 3] Evaluation complete. Assembling Book...');
    await assembleBook(state);
}

async function assembleBook(state) {
    const chunks = state.getChunks();
    const outputPath = path.join(state.workDir, 'RESULT_V3.txt');

    // Clear file
    fs.writeFileSync(outputPath, '');

    for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        let bestText = "";

        if (c.evaluation && c.evaluation.best_index !== undefined) {
            let idx = c.evaluation.best_index;
            // Safety check index
            if (idx < 0 || idx >= c.variants.length) idx = 0;
            bestText = c.variants[idx];
        } else if (c.variants && c.variants.length > 0) {
            // No eval but have variants? Take first.
            bestText = c.variants[0];
        } else {
            // No variants? Use original? Or Placeholder?
            bestText = `[ERROR: NO TRANSLATION FOR CHUNK ${i}]`;
        }

        fs.appendFileSync(outputPath, bestText + '\n');
    }

    console.log(`--- SYSTEM: Book Assembled to ${outputPath} ---`);
}
