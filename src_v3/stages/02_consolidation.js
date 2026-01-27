import fs from 'fs';
import path from 'path';
import { llmManager } from '../core/llm_client.js';
import { HumanMessage } from "@langchain/core/messages";

export async function runConsolidationStage(state) {
    console.log('--- SYSTEM: Starting Stage 1b (Consolidation + Context) ---');

    const chunks = state.getChunks();
    const allTerms = new Map();

    // 1. Aggregation with Context
    console.log('[Consolidation] Aggregating terms and contexts...');
    chunks.forEach(chunk => {
        if (chunk.extracted_terms && Array.isArray(chunk.extracted_terms)) {
            chunk.extracted_terms.forEach(term => {
                if (!term.original) return;

                const key = term.original.toLowerCase().trim();
                if (!allTerms.has(key)) {
                    allTerms.set(key, {
                        original: term.original,
                        type: term.type,
                        count: 1,
                        variants: [term.original],
                        contexts: term.context ? [term.context] : []
                    });
                } else {
                    const existing = allTerms.get(key);
                    existing.count++;
                    // Collect up to 5 unique variant spellings
                    if (!existing.variants.includes(term.original) && existing.variants.length < 5) {
                        existing.variants.push(term.original);
                    }
                    // Collect up to 3 distinct context examples to help translation
                    if (term.context && existing.contexts.length < 3) {
                        // Simple dedup by string content
                        if (!existing.contexts.includes(term.context)) {
                            existing.contexts.push(term.context);
                        }
                    }
                }
            });
        }
    });

    console.log(`[Consolidation] Found ${allTerms.size} unique raw terms.`);

    if (allTerms.size === 0) {
        console.warn('[Consolidation] No terms found. Glossary will be empty.');
        return;
    }

    // 2. Prepare for LLM - Sort by frequency to prioritize important terms
    const rawList = Array.from(allTerms.values())
        .map(t => ({
            original: t.original,
            count: t.count,
            variants: t.variants,
            contexts: t.contexts,
            type: t.type
        }))
        .sort((a, b) => b.count - a.count); // Most frequent first

    const BATCH_SIZE = 30; // Reduced batch size due to added context field
    let finalGlossary = [];
    const client = llmManager.getClient('logic');

    for (let i = 0; i < rawList.length; i += BATCH_SIZE) {
        const batch = rawList.slice(i, i + BATCH_SIZE);
        console.log(`[Consolidation] Processing batch ${(i / BATCH_SIZE) + 1}/${Math.ceil(rawList.length / BATCH_SIZE)}...`);

        // Minify context for prompt to save tokens
        const promptInput = batch.map(b => ({
            orig: b.original,
            ctx: b.contexts.join(' | ').slice(0, 200) // Truncate long contexts
        }));

        const prompt = `
        Ты - главный редактор. Создай чистовой глоссарий для перевода книги.
        
        Вход: Список терминов (orig) с примерами использования/контекстом (ctx).
        Задача:
        1. Проанализируй термины. Если это мусор или обычные слова (не имена/термины) - ИГНОРИРУЙ их.
        2. Объедини очевидные дубликаты.
        3. Переведи на русский.
        4. Укажи пол (m/f/n) для имен.
        
        Формат ответа (JSON список):
        [
          { "original": "Term", "translation": "Термин", "type": "name|term", "gender": "m", "notes": "пояснение" }
        ]
        `;

        const userMessage = JSON.stringify(promptInput);

        // Retry logic for each batch
        let retries = 3;
        let success = false;

        while (retries > 0 && !success) {
            try {
                const response = await client.invoke([
                    new HumanMessage(prompt),
                    new HumanMessage(userMessage)
                ]);

                let content = response.content.replace(/```json/g, '').replace(/```/g, '').trim();
                // Fix potential trailing commas or markdown noise
                const batchResult = JSON.parse(content);

                if (Array.isArray(batchResult)) {
                    finalGlossary.push(...batchResult);
                    success = true;
                } else {
                    throw new Error("Response is not an array");
                }
            } catch (e) {
                console.error(`[Consolidation] Batch failed (Attempts left: ${retries - 1}): ${e.message}`);
                retries--;
                if (retries === 0) {
                    console.error(`[Consolidation] SKIPPING BATCH due to repeated errors.`);
                } else {
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
        }
    }

    // 3. Final Save
    const glossaryPath = path.join(state.workDir, 'glossary.json');
    fs.writeFileSync(glossaryPath, JSON.stringify(finalGlossary, null, 2));

    console.log(`[Consolidation] Glossary saved to ${glossaryPath} (${finalGlossary.length} items)`);
    console.log('--- SYSTEM: Stage 1b Completed ---');
}
