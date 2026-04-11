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

    // 2. Load existing glossary to merge with (don't lose previous results on rerun)
    const glossaryPath = state.getGlossaryPath();
    let existingGlossary = [];
    if (fs.existsSync(glossaryPath)) {
        try {
            existingGlossary = JSON.parse(fs.readFileSync(glossaryPath, 'utf-8'));
            console.log(`[Consolidation] Loaded existing glossary with ${existingGlossary.length} items (will merge).`);
        } catch (e) {
            console.warn(`[Consolidation] Failed to parse existing glossary: ${e.message}. Starting fresh.`);
        }
    }
    // Index existing terms by lowercase original for dedup
    const existingKeys = new Set(existingGlossary.map(t => t.original?.toLowerCase().trim()));

    // 3. Prepare for LLM - Sort by frequency to prioritize important terms
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
    const MAX_RETRIES = 3;
    let newTerms = [];
    let skippedBatches = [];
    const client = llmManager.getClient('logic');

    for (let i = 0; i < rawList.length; i += BATCH_SIZE) {
        const batch = rawList.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(rawList.length / BATCH_SIZE);
        console.log(`[Consolidation] Processing batch ${batchNum}/${totalBatches}...`);

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
        
        Рассуждай шаг за шагом.
        JSON должен быть обернут в тройные кавычки (markdown block).
        Формат ответа (JSON список):
        \`\`\`json
        [
          { "original": "Term", "translation": "Термин", "type": "name|term", "gender": "m", "notes": "пояснение" }
        ]
        \`\`\``;

        const userMessage = JSON.stringify(promptInput);

        let attempts = 0;
        let success = false;

        while (attempts < MAX_RETRIES && !success) {
            attempts++;
            try {
                const response = await client.invoke([
                    new HumanMessage(prompt),
                    new HumanMessage(userMessage)
                ]);

                // Check for empty/truncated response
                const content = response.content;
                if (!content || content.trim().length === 0) {
                    console.warn(`[Consolidation] Empty response for batch ${batchNum}, attempt ${attempts}. Retrying...`);
                    continue;
                }

                const batchResult = extractJson(content);

                if (Array.isArray(batchResult)) {
                    newTerms.push(...batchResult);
                    success = true;
                } else {
                    throw new Error("Response is not an array");
                }
            } catch (e) {
                console.error(`[Consolidation] Batch ${batchNum} attempt ${attempts}/${MAX_RETRIES} failed: ${e.message}`);
                if (attempts >= MAX_RETRIES) {
                    const skippedTerms = batch.map(b => b.original);
                    skippedBatches.push({ batchNum, terms: skippedTerms });
                    console.error(`[Consolidation] SKIPPING BATCH ${batchNum}. Lost terms: ${skippedTerms.join(', ')}`);
                } else {
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
        }
    }

    // 4. Merge: existing glossary + new terms (dedup by original)
    let finalGlossary = [...existingGlossary];
    let addedCount = 0;
    for (const term of newTerms) {
        const key = term.original?.toLowerCase().trim();
        if (key && !existingKeys.has(key)) {
            finalGlossary.push(term);
            existingKeys.add(key);
            addedCount++;
        }
    }

    // 5. Save
    fs.writeFileSync(glossaryPath, JSON.stringify(finalGlossary, null, 2));

    console.log(`[Consolidation] Glossary saved to ${glossaryPath} (${finalGlossary.length} total, ${addedCount} new).`);

    if (skippedBatches.length > 0) {
        console.warn(`\n⚠️  WARNING: ${skippedBatches.length} batch(es) were SKIPPED due to LLM errors!`);
        console.warn(`   The following terms may be MISSING from the glossary:`);
        skippedBatches.forEach(sb => {
            console.warn(`   Batch ${sb.batchNum}: ${sb.terms.join(', ')}`);
        });
        console.warn(`   Re-run Stage 1b to retry these batches.\n`);
    }

    console.log('--- SYSTEM: Stage 1b Completed ---');
}

function extractJson(text) {
    try {
        const jsonMatch = text.match(/```json([\s\S]*?)```/);
        if (jsonMatch) return JSON.parse(jsonMatch[1]);

        // Try to find [ ... ]
        const arrayMatch = text.match(/\[[\s\S]*\]/);
        if (arrayMatch) return JSON.parse(arrayMatch[0]);

        // Try to find { ... } - though we expect array here
        const bracketMatch = text.match(/\{[\s\S]*\}/);
        if (bracketMatch) return JSON.parse(bracketMatch[0]);

        // Fallback: try parsing whole text if clean
        return JSON.parse(text);
    } catch (e) {
        throw new Error("No JSON found or invalid JSON: " + e.message);
    }
}
