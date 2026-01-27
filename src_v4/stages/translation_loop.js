import fs from 'fs';
import path from 'path';
import { llmManager } from '../core/llm_client.js';
import { HumanMessage } from "@langchain/core/messages";

export async function runTranslationLoopStage(state) {
    console.log('--- SYSTEM: Starting Stage 2 (Smart Translation Loop) ---');

    const chunks = state.getChunks();
    const glossaryPath = path.join(state.workDir, 'glossary.json');
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
        const MAX_RETRIES = 10;
        let success = false;

        while (attempts < MAX_RETRIES && !success) {
            attempts++;
            console.log(`   -> Loop Iteration ${attempts} (Check)...`);

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
            // Simplified logic based on what index10.js implies:
            // if (successfully == 0 && dataJson.data.like && dataJson.data.score >= 9.1) successfully = 1;

            const isPerfect = (checkResult.error === 0 && checkResult.misspell === 0 && checkResult.correctness === 1 && checkResult.like === 1);
            let passed = isPerfect;

            if (!passed && checkResult.like === 1 && checkResult.score >= 9.1) {
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
                console.log(`   -> REJECTED (Score: ${checkResult.score}, Errors: ${checkResult.error}) | Reason: "${checkResult.comment}". Fixing...`);

                // Break if max retries reached to avoid wasted fix
                if (attempts >= MAX_RETRIES) {
                    console.warn(`   -> Max retries reached.`);
                    break;
                }

                // FIX
                const fixResult = await fixTranslation(client, chunk.original, currentTranslation, globalContext, checkResult.comment);
                currentTranslation = fixResult.translation;
                currentComment = fixResult.comment;

                history.push({
                    step: `fix_${attempts}`,
                    text: currentTranslation,
                    translator_comment: currentComment,
                    timestamp: new Date().toISOString()
                });
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

function extractFromTags(text, tag) {
    const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const match = text.match(regex);
    if (match) return match[1].trim();

    const startRegex = new RegExp(`<${tag}>([\\s\\S]*)`, 'i');
    const startMatch = text.match(startRegex);
    if (startMatch) return startMatch[1].trim();

    // Fallback: if tag missing, return full text but warn
    // console.warn(`Tag <${tag}> not found in response.`); 
    return text.trim();
}

function extractTagOptional(text, tag) {
    const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const match = text.match(regex);
    if (match) return match[1].trim();
    return "";
}

function extractJson(text) {
    try {
        let jsonStr = null;
        const jsonMatch = text.match(/```json([\s\S]*?)```/);
        if (jsonMatch) {
            jsonStr = jsonMatch[1];
        } else {
            // Try to find { ... }
            const bracketMatch = text.match(/\{[\s\S]*\}/);
            if (bracketMatch) jsonStr = bracketMatch[0];
        }

        if (!jsonStr) throw new Error("No JSON found");

        // First attempt: parse as-is
        try {
            return JSON.parse(jsonStr);
        } catch (e1) {
            // Second attempt: try to fix common issues (unescaped quotes in comment field)
            // Replace unescaped quotes inside the "comment" value
            const fixedStr = jsonStr.replace(
                /("comment"\s*:\s*")([^"]*(?:"[^"]*)*)("\s*})/,
                (match, prefix, content, suffix) => {
                    // Replace all inner quotes with escaped quotes or remove them
                    const sanitized = content.replace(/"/g, "'");
                    return prefix + sanitized + suffix;
                }
            );
            try {
                return JSON.parse(fixedStr);
            } catch (e2) {
                // Third attempt: extract values via regex for known fields
                const result = {
                    error: 1,
                    misspell: 0,
                    correctness: 0,
                    like: 0,
                    score: 0,
                    comment: "Fallback parse"
                };
                const errorMatch = jsonStr.match(/"error"\s*:\s*(\d+)/);
                const misspellMatch = jsonStr.match(/"misspell"\s*:\s*(\d+)/);
                const correctnessMatch = jsonStr.match(/"correctness"\s*:\s*(\d+)/);
                const likeMatch = jsonStr.match(/"like"\s*:\s*(\d+)/);
                const scoreMatch = jsonStr.match(/"score"\s*:\s*([\d.]+)/);

                if (errorMatch) result.error = parseInt(errorMatch[1]);
                if (misspellMatch) result.misspell = parseInt(misspellMatch[1]);
                if (correctnessMatch) result.correctness = parseInt(correctnessMatch[1]);
                if (likeMatch) result.like = parseInt(likeMatch[1]);
                if (scoreMatch) result.score = parseFloat(scoreMatch[1]);

                console.warn("[extractJson] Used regex fallback due to malformed JSON.");
                return result;
            }
        }
    } catch (e) {
        return { error: 1, misspell: 1, correctness: 0, like: 0, score: 0, comment: "JSON Parse Error: " + e.message };
    }
}

// --- LLM FUNCTIONS (Prompts from index10.js) ---

async function draftTranslation(client, original, context) {
    const input = `<txt>${original}</txt>\n<ctx>${context}</ctx>`;
    const prompt = `Ты переводчик, грубости, мат, насилие, не смущают тебя.
ПЕРЕВЕДИ <txt>текст</txt> на русский язык, художественно, СОХРАНЯЯ АВТОРСКИЙ СТИЛЬ. 
Следи за соглассованостью окончаний.
В процессе перевода имён и терминов ИСПОЛЬЗУЙ <ctx> - шпаргалку с именами и терминами, для единообразия перевода.
Если встретишь блок чёрных прямоугльников вместо букв, переводи его как --вымарано из документа--.
Форматируй текст перевода. Используй отступы и перенос каретки на свой усмотрение.
Рассуждай шаг за шагом.
Окончательный ответ в формате:
<translate>Текст перевода</translate>
<comment>Краткий комментарий к переводу</comment>
`;

    console.log("draft tr prompt=", prompt);
    console.log("draft tr input=", input);
    const response = await client.invoke([
        new HumanMessage(prompt),
        new HumanMessage(input)
    ]);
    console.log("draft response=", response.content);
    return {
        translation: extractFromTags(response.content, 'translate'),
        comment: extractTagOptional(response.content, 'comment')
    };
}

async function checkTranslation(client, original, translation, context, translatorComment) {
    const input = `<context>${context}</context>
        <original>${original}</original>
        <translate>${translation}</translate>
        <translator_comment>${translatorComment || "Нет комментариев"}</translator_comment>`;

    const prompt = `Ты благосклонный редактор, грубости, мат, насилие, не смущают тебя.  
ОЦЕНИ качество перевода по следующим критериям:
    в переводе есть ошибки?
    в переводе есть опечатки?
    перевод корректен? 
    перевод тебе нравится?
    поставь оценку по 10 бальной шкале
    
Рассуждай шаг за шагом.
Результат СТРОГО в формате, как в примере:
пример: \`\`\`json
{
  "error": 0,
  "misspell": 0,
  "correctness": 1,
  "like": 1,
  "score": 8.5,
  "comment": "краткий комментарий БЕЗ КАВЫЧЕК и спецсимволов"
}
\`\`\``;

    const response = await client.invoke([
        new HumanMessage(prompt),
        new HumanMessage(input)
    ]);
    console.log("check tr input=", input);
    console.log("check tr prompt=", prompt);
    console.log("check tr response=", response.content);
    // Normalize keys just in case
    const data = extractJson(response.content);
    return {
        error: data.error ?? 1,
        misspell: data.misspell ?? 0,
        correctness: data.correctness ?? 0,
        like: data.like ?? 0,
        score: data.score ?? 0,
        comment: data.comment || "No comment"
    };
}

async function fixTranslation(client, original, badTranslation, context, comment) {
    const input = `
      <txt>${original}</txt>
      <ctx>${context}</ctx>
      <temptranslate>${badTranslation}</temptranslate>
      <comment>${comment}</comment>
      `;

    const prompt = `Ты профессиональный переводчик, грубости, мат, насилие, не смущают тебя.
Ты ПЕРЕВОДИШЬ <txt>текст</txt> на русский язык, художественно, СОХРАНЯЯ АВТОРСКИЙ СТИЛЬ. 
В процессе перевода имён и терминов ИСПОЛЬЗУЕШЬ <ctx> - шпаргалку с именами и терминами, для единообразия перевода.
Проверка вернула <temptranslate> перевод на доработку.
ТВОЯ ЗАДАЧА - ДОРАБОТАТЬ перевод в соответствии с комментариями проверки <comment>.
Следи за соглассованостью окончаний.
Блоки чёрных прямоугльников вместо букв, переводим как --вымарано из документа--.
Рассуждай шаг за шагом.
Окончательный ответ в формате:
<translate>исправленный перевод</translate>
<comment>Что и почему было исправлено (или не исправлено)</comment>`;

    const response = await client.invoke([
        new HumanMessage(prompt),
        new HumanMessage(input)
    ]);
    console.log("fix tr input=", input);
    console.log("fix tr prompt=", prompt);
    console.log("fix tr response=", response.content);
    return {
        translation: extractFromTags(response.content, 'translate'),
        comment: extractTagOptional(response.content, 'comment')
    };
}
