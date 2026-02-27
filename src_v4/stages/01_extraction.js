import { llmManager } from '../core/llm_client.js';
import { HumanMessage } from "@langchain/core/messages";

export async function runExtractionStage(state) {
    console.log('--- SYSTEM: Starting Stage 1 (Extraction) ---');

    const chunks = state.getChunks();
    const client = llmManager.getClient('logic');

    let processedCount = 0;

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        // Skip if already extracted
        if (chunk.extracted_terms) {
            continue;
        }

        console.log(`[Stage 1] Processing Chunk ${i + 1}/${chunks.length}...`);

        const prompt = `
        Ты - аналитик текста. Твоя задача - извлечь из фрагмента текста все **имена персонажей** и **специфические термины**, которые могут потребовать унификации при переводе.
        Особое внимание удели:
        1. Именам (людей, клички, названия существ).
        2. Редким или выдуманным терминам (технологии, магия, организации).
        Рассуждай шаг за шагом.
        Выведи окончательный результат строго в формате JSON:
        JSON должен быть обернут в тройные кавычки (markdown block).
        
        Пример ответа:
        \`\`\`json
        [
          { "original": "Name", "type": "name", "gender": "male|female|unknown", "context": "Краткое описание на русском кто это или что это по тексту" },
          { "original": "Term", "type": "term", "context": "Описание на русском, например: вид оружия, организация" }
        ]
        \`\`\`
        Если ничего не найдено, верни пустой массив [].
        Не выдумывай. Извлекай только то, что есть в тексте.
        `;

        const userMessage = `Текст: \n${chunk.original}`;

        try {
            console.log('prompt=', prompt)
            console.log('userMessage=', userMessage)
            const response = await client.invoke([
                new HumanMessage(prompt),
                new HumanMessage(userMessage)
            ]);

            const content = response.content;
            console.log('content=', content)
            let extracted = [];

            // Try to parse JSON
            try {
                // Use robust extraction
                extracted = extractJson(content);
                if (!Array.isArray(extracted)) {
                    console.warn(`[Stage 1] Parsed result is not an array for chunk ${i}. Using [].`);
                    extracted = [];
                }
            } catch (e) {
                console.warn(`[Stage 1] Failed to parse JSON for chunk ${i}: ${e.message}`, content);
                extracted = [];
            }

            // Update state
            state.updateChunk(i, { extracted_terms: extracted });

            // Save after every chunk
            processedCount++;
            state.save();
            console.log(`[Stage 1] Saved progress.`);

        } catch (error) {
            console.error(`[Stage 1] Error processing chunk ${i}: ${error.message}`);
            // Save what we have and stop? Or continue? 
            // Better to stop/throw so user notices, or retry.
            // For now, let's retry once then throw.
            throw error;
        }
    }

    state.save();
    console.log('--- SYSTEM: Stage 1 (Extraction) Completed ---');
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
