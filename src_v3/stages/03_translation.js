import fs from 'fs';
import path from 'path';
import { llmManager } from '../core/llm_client.js';
import { HumanMessage } from "@langchain/core/messages";

export async function runTranslationStage(state) {
    console.log('--- SYSTEM: Starting Stage 2 (Multi-Variant Translation) ---');

    const chunks = state.getChunks();
    const glossaryPath = path.join(state.workDir, 'glossary.json');

    if (!fs.existsSync(glossaryPath)) {
        throw new Error(`Glossary file not found at ${glossaryPath}. Please run Stage 1b first.`);
    }

    const glossary = JSON.parse(fs.readFileSync(glossaryPath, 'utf-8'));
    console.log(`[Stage 2] Loaded glossary with ${glossary.length} terms.`);

    const client = llmManager.getClient('fast'); // HY-MT logic

    // Temperatures for 3 variants: Strict, Balanced, Creative
    // 0.6 оптимальный для быстрого перевода 
    const temperatures = [0.7, 0.6, 0.6];

    let processedCount = 0;

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        // Resume check: if we already have 3 variants, skip
        if (chunk.variants && chunk.variants.length === 3) {
            continue;
        }

        console.log(`[Stage 2] Translating Chunk ${i + 1}/${chunks.length}...`);

        // 1. Build Local Context
        const localContext = getLocalContext(chunk.original, glossary);
        let contextString = "";
        if (localContext.length > 0) {
            contextString = localContext.map(t => `${t.original} -> ${t.translation}`).join('\n');
        }

        // 2. Prepare Prompt
        // "Terminology-Guided" prompt from manual, adapted to Russian
        let promptText = "";
        if (contextString) {
            promptText += `Справочник терминов:\n${contextString}\n\n`;
        }

        promptText += `Переведи текст, заключенный в теги <source>, на русский язык.
Используй термины из справочника.
Выведи результат строго внутри тегов <target>.\n\n<source>${chunk.original}</source>`;

        // 3. Generate Variants
        const variants = [];

        for (let t = 0; t < temperatures.length; t++) {
            const temp = temperatures[t];
            // Update temp for this request - wait, LangChain client is initialized with fixed temp.
            // We need to override it if possible, or re-init?
            // ChatOpenAI allows bind({ temperature: ... }) or passing in call options? 
            // LangChain.js standard invoke options usually include 'temperature' but it depends on provider.
            // For OpenAI-compatible, it's often best to set it in the client.
            // Let's rely on llmManager caching but maybe we need a way to clone/override? 
            // OR simpler: just instantiate a temporary client configuration or use the one client but pass options.
            // Checking ChatOpenAI docs: invoke(messages, options) -> options can have bindable params.
            // Actually, for local servers, just sending "temperature" in body is standard.

            // Let's try passing bind options or just re-using the client with a hack if needed.
            // Ideally: client.bind({ temperature: temp }).invoke(...)

            try {
                const response = await client.bind({ temperature: temp }).invoke([
                    new HumanMessage(promptText)
                ]);

                let rawContent = response.content.trim();
                let translation = "";

                try {
                    translation = extractFromTags(rawContent, 'target');
                } catch (err) {
                    console.warn(`[Stage 2] Tag extraction failed for variant ${t + 1} (Chunk ${i}): ${err.message}. Saving raw.`);
                    translation = rawContent;
                }

                variants.push(translation);

            } catch (e) {
                console.error(`[Stage 2] Error generating variant ${t + 1} for chunk ${i}: ${e.message}`);
                variants.push("");
            }
        }

        // Update state
        state.updateChunk(i, { variants: variants });

        // Save periodically
        processedCount++;
        if (processedCount % 5 === 0) {
            state.save();
            console.log(`[Stage 2] Saved progress.`);
        }
    }

    state.save();
    console.log('--- SYSTEM: Stage 2 Completed ---');
}

/**
 * Filter glossary for terms present in the text
 */
function getLocalContext(text, glossary) {
    const hits = [];
    // Convert text to lower for case-insensitive search logic
    const lowerText = text.toLowerCase();

    glossary.forEach(term => {
        // Simple substring match. 
        // Ideally should be token-based to avoid "Ale" matching "Alexander", 
        // but for now simple check is usually sufficient for glossary injection.
        // We check if the original term is in the text.
        if (lowerText.includes(term.original.toLowerCase())) {
            hits.push(term);
        }
    });
    return hits;
}

function extractFromTags(response, tag) {
    const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const match = response.match(regex);

    if (!match) {
        const startRegex = new RegExp(`<${tag}>([\\s\\S]*)`, 'i');
        const startMatch = response.match(startRegex);
        if (startMatch) {
            return startMatch[1].trim();
        }
        throw new Error(`Tag <${tag}> not found`);
    }
    return match[1].trim();
}
