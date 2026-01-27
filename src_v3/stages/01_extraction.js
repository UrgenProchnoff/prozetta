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
        
        Выведи результат строго в формате JSON:
        [
          { "original": "Name", "type": "name", "gender": "male|female|unknown", "context": "Краткое описание кто это или что это по тексту" },
          { "original": "Term", "type": "term", "context": "Описание, например: вид оружия, организация" }
        ]
        Если ничего не найдено, верни пустой массив [].
        Не выдумывай. Извлекай только то, что есть в тексте.
        `;

        const userMessage = `Текст: \n${chunk.original}`;

        try {
            const response = await client.invoke([
                new HumanMessage(prompt),
                new HumanMessage(userMessage)
            ]);

            const content = response.content;
            let extracted = [];

            // Try to parse JSON
            try {
                // Remove Markdown code blocks if present
                const cleaner = content.replace(/```json/g, '').replace(/```/g, '').trim();
                extracted = JSON.parse(cleaner);
            } catch (e) {
                console.warn(`[Stage 1] Failed to parse JSON for chunk ${i}:`, content);
                // Save raw content for manual review later? Or just empty array to safeguard.
                extracted = [];
            }

            // Update state
            state.updateChunk(i, { extracted_terms: extracted });

            // Save every 5 chunks to minimize I/O
            processedCount++;
            if (processedCount % 5 === 0) {
                state.save();
                console.log(`[Stage 1] Saved progress.`);
            }

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
