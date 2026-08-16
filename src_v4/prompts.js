/**
 * Все промпты пайплайна в одном месте — для удобной правки и тюнинга.
 *
 * Промпты собраны в два набора — `ru` и `en` — по языку САМИХ ИНСТРУКЦИЙ
 * модели (не путать с целевым языком перевода). Набор выбирается настройкой
 * `config.translation.promptLang`. Целевой язык перевода (`targetLanguage`)
 * подставляется в шаблоны параметром, поэтому каждый `system` — это функция
 * от целевого языка.
 *
 * Каждый шаг содержит:
 *   system — функция (targetLang) => инструкция модели (что делать, формат ответа);
 *   user   — построитель сообщения с данными (текст чанка, контекст и т.п.).
 *
 * `user`-построители от языка не зависят и общие для обоих наборов.
 */

// --- user-построители (общие для всех языков) ---
const userBuilders = {
    extraction: (chunkText) => `Текст: \n${chunkText}`,
    passport: (bookText, evidence) =>
`<evidence>${JSON.stringify(evidence, null, 1)}</evidence>

<book>
${bookText}
</book>`,
    consolidation: (items) => JSON.stringify(items),
    // `style` — решения из паспорта книги (см. core/passport.js buildStyleBlock).
    // Пустая строка означает «паспорта нет», и тег не добавляется вовсе, чтобы
    // проекты без паспорта получали байт-в-байт прежние промпты.
    draft: (original, context, style) =>
        `<txt>${original}</txt>\n<ctx>${context}</ctx>` + (style ? `\n<style>${style}</style>` : ''),
    check: (context, original, translation, translatorComment, style) =>
`<context>${context}</context>${style ? `\n<style>${style}</style>` : ''}
        <original>${original}</original>
        <translate>${translation}</translate>
        <translator_comment>${translatorComment || "Нет комментариев"}</translator_comment>`,
    fix: (original, context, badTranslation, comment, style) =>
`
      <txt>${original}</txt>
      <ctx>${context}</ctx>${style ? `\n      <style>${style}</style>` : ''}
      <temptranslate>${badTranslation}</temptranslate>
      <comment>${comment}</comment>
      `,
};

// --- Русский набор инструкций ---
const ru = {
    // --- Этап 1: извлечение терминов (01_extraction.js) ---
    extraction: {
        system: (targetLang) => `
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
        `,
        user: userBuilders.extraction,
    },

    // --- Паспорт книги: один вызов на весь текст (03_passport.js) ---
    passport: {
        system: (targetLang) => `
        Ты - литературный аналитик. Тебе дан ПОЛНЫЙ текст книги.

        В <evidence> — то, что уже посчитано по тексту механически: лицо повествования,
        список кандидатов в персонажи с числом упоминаний, долей упоминаний в прямой речи
        и свидетельствами о поле по местоимениям. Опирайся на эти цифры, но если текст
        говорит иное — доверяй тексту.

        Определи:

        1. КАК ведётся повествование: от какого лица, в каком времени, и — если
           повествование от 2-го лица — как обращаться к читателю на ${targetLang}.
           Это решение принимается один раз на всю книгу.

        2. ОТ ЧЬЕГО ЛИЦА идёт повествование. Нужны только фокальные персонажи — те,
           чьими глазами читатель видит происходящее. НЕ перечисляй всех важных
           героев: тот, о ком много говорят, но чьими глазами мы не смотрим,
           в этот список не входит. Если фокальный персонаж один - верни одного.

        3. На каждого фокального персонажа - ДОСЬЕ: род занятий, звание или должность,
           место работы, ключевые связи с другими персонажами, приметы речи и быта.
           Пиши телеграфно, без прозы. Проверка качества досье такая: по нему можно
           опознать главу этого персонажа по одному абзацу, не встретив его имени.

        Рассуждай шаг за шагом.
        JSON должен быть обёрнут в тройные кавычки (markdown block).

        Пример ответа:
        \`\`\`json
        {
          "narration": {
            "person": "first|second|third",
            "tense": "present|past",
            "addressForm": "ТОЛЬКО само местоимение обращения к читателю на ${targetLang} (например «ты» или «вы»), без пояснений; null если повествование не от 2-го лица",
            "reason": "коротко, на чём основано; сюда же любые оговорки про обращение"
          },
          "povCharacters": [
            { "name": "Имя как в оригинале", "gender": "m|f|n", "dossier": "телеграфное досье" }
          ]
        }
        \`\`\``,
        user: userBuilders.passport,
    },

    // --- Этап 1b: консолидация в глоссарий (02_consolidation.js) ---
    consolidation: {
        system: (targetLang) => `
        Ты - главный редактор. Создай чистовой глоссарий для перевода книги.

        Вход: Список терминов (orig) с примерами использования/контекстом (ctx).
        Задача:
        1. Проанализируй термины. Если это мусор или обычные слова (не имена/термины) - ИГНОРИРУЙ их.
        2. Объедини дубликаты.
        3. Переведи на ${targetLang}.
        4. Укажи пол (m/f/n) для имен.

        Рассуждай шаг за шагом.
        JSON должен быть обернут в тройные кавычки (markdown block).
        Формат ответа (JSON список):
        \`\`\`json
        [
          { "original": "Term", "translation": "Термин", "type": "name|term", "gender": "m", "notes": "пояснение" }
        ]
        \`\`\``,
        user: userBuilders.consolidation,
    },

    // --- Этап 2: черновик перевода (translation_loop.js) ---
    draft: {
        system: (targetLang) => `Ты переводчик, грубости, мат, насилие, не смущают тебя.
ПЕРЕВЕДИ <txt>текст</txt> на ${targetLang} язык, художественно, СОХРАНЯЯ АВТОРСКИЙ СТИЛЬ.
В процессе перевода имён и терминов ИСПОЛЬЗУЙ <ctx> - шпаргалку с именами и терминами, для единообразия перевода.
В <style> (если задан) — обязательные решения, принятые ОДИН РАЗ на всю книгу: лицо и время повествования, форма обращения к читателю, пол повествователя. СОБЛЮДАЙ ИХ СТРОГО.
Область действия <style> — ТОЛЬКО авторское повествование. Прямая речь, письма, протоколы, стенограммы, чаты и прочие вставные документы — вне <style>: там персонажи обращаются друг к другу согласно их отношениям, и вежливое «вы» между ними уместно.
СОХРАНЯЙ РАЗБИВКУ НА АБЗАЦЫ оригинала один в один: сколько абзацев в <txt>, столько же должно быть в переводе.
Не разбивай абзац на несколько и не склеивай соседние. Отступы в начале абзаца повторяй как в оригинале.
Окончательный ответ в формате:
<translate>Текст перевода</translate>
<comment>Краткий комментарий к переводу</comment>
`,
        user: userBuilders.draft,
    },

    // --- Этап 2: проверка перевода (translation_loop.js) ---
    check: {
        system: (targetLang) => `Ты редактор, грубости, мат, насилие, не смущают тебя.
Тебе предоставлены:
- <original> - оригинальный текст
- <translate> - перевод на ${targetLang}
- <context> - шпаргалка с именами и терминами
- <style> - (если задан) обязательные решения по всей книге: лицо и время повествования, обращение к читателю, пол повествователя
- <translator_comment> - комментарий переводчика

ОЦЕНИ качество перевода по следующим критериям:
    в переводе есть ошибки?
    в переводе есть опечатки?
    перевод корректен?
    соответствуют ли переводы имен и терминов шпаргалке <context>?
    соблюдены ли решения <style> в АВТОРСКОМ ПОВЕСТВОВАНИИ (лицо, время, «ты»/«вы», род повествователя)? Нарушение <style> в повествовании — ошибка.
    ВАЖНО: прямая речь и вставные документы (письма, протоколы, стенограммы, чаты) под <style> НЕ подпадают — вежливое «вы» между персонажами там НЕ ошибка.
    ВАЖНО про время: сверяй его с <original> ПОФРАЗОВО. Прошедшее время там, где оно стоит в оригинале (воспоминания, предыстория), — НЕ ошибка. Прежде чем объявить нарушение времени, процитируй в comment глагол оригинала в этом месте.
    перевод тебе нравится?
    поставь оценку по 10 бальной шкале

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
\`\`\``,
        user: userBuilders.check,
    },

    // --- Этап 2: доработка перевода (translation_loop.js) ---
    fix: {
        system: (targetLang) => `Ты профессиональный переводчик, грубости, мат, насилие, не смущают тебя.
Ты ПЕРЕВОДИШЬ <txt>текст</txt> на ${targetLang} язык, художественно, СОХРАНЯЯ АВТОРСКИЙ СТИЛЬ.
В процессе перевода имён и терминов ИСПОЛЬЗУЕШЬ <ctx> - шпаргалку с именами и терминами, для единообразия перевода.
В <style> (если задан) — обязательные решения по всей книге: лицо и время повествования, обращение к читателю, пол повествователя. СОБЛЮДАЙ ИХ СТРОГО.
Область действия <style> — ТОЛЬКО авторское повествование; прямая речь и вставные документы (письма, протоколы, чаты) — вне <style>, там уместно вежливое «вы» между персонажами.
СОХРАНЯЙ РАЗБИВКУ НА АБЗАЦЫ оригинала один в один: сколько абзацев в <txt>, столько же должно быть в переводе.
Проверка вернула <temptranslate> перевод на доработку.
ТВОЯ ЗАДАЧА - ДОРАБОТАТЬ перевод в соответствии с комментариями проверки <comment>.
Окончательный ответ в формате:
<translate>исправленный перевод</translate>
<comment>Что и почему было исправлено (или не исправлено)</comment>`,
        user: userBuilders.fix,
    },
};

// --- English instruction set ---
const en = {
    // --- Stage 1: term extraction (01_extraction.js) ---
    extraction: {
        system: (targetLang) => `
        You are a text analyst. Your task is to extract from the text fragment all **character names** and **specific terms** that may require consistency when translating.
        Pay special attention to:
        1. Names (people, nicknames, names of creatures).
        2. Rare or invented terms (technology, magic, organizations).
        Reason step by step.
        Output the final result strictly as JSON:
        The JSON must be wrapped in triple backticks (markdown block).

        Example response:
        \`\`\`json
        [
          { "original": "Name", "type": "name", "gender": "male|female|unknown", "context": "Short description in English of who or what this is in the text" },
          { "original": "Term", "type": "term", "context": "Description in English, e.g.: a kind of weapon, an organization" }
        ]
        \`\`\`
        If nothing is found, return an empty array [].
        Do not make things up. Extract only what is in the text.
        `,
        user: userBuilders.extraction,
    },

    // --- Book passport: one call over the whole text (03_passport.js) ---
    passport: {
        system: (targetLang) => `
        You are a literary analyst. You are given the COMPLETE text of a book.

        <evidence> holds what has already been measured mechanically: the narrative
        person, and a list of candidate characters with mention counts, the share of
        mentions occurring inside quoted speech, and pronoun evidence for gender. Lean
        on those numbers, but where the text disagrees with them, trust the text.

        Determine:

        1. HOW the narration works: which person, which tense, and — if the narration
           is in the second person — how the reader should be addressed in ${targetLang}.
           This is decided once for the whole book.

        2. WHOSE point of view it is told from. Only focal characters count — the ones
           through whose eyes the reader sees events. Do NOT list every important
           character: someone who is talked about a great deal but never the viewpoint
           is not on this list. If there is a single focal character, return one.

        3. For each focal character, a DOSSIER: occupation, rank or job title, place of
           work, key relationships, marks of speech and daily life. Write it
           telegraphically, not as prose. The test of a good dossier: it should let you
           recognise that character's chapter from a single paragraph without their
           name appearing in it.

        Reason step by step.
        The JSON must be wrapped in triple backticks (markdown block).

        Example response:
        \`\`\`json
        {
          "narration": {
            "person": "first|second|third",
            "tense": "present|past",
            "addressForm": "ONLY the bare address pronoun for the reader in ${targetLang} (e.g. «ты» or «вы»), no explanations; null unless the narration is second person",
            "reason": "briefly, what this rests on; any caveats about the address go here too"
          },
          "povCharacters": [
            { "name": "Name as in the original", "gender": "m|f|n", "dossier": "telegraphic dossier" }
          ]
        }
        \`\`\``,
        user: userBuilders.passport,
    },

    // --- Stage 1b: consolidation into a glossary (02_consolidation.js) ---
    consolidation: {
        system: (targetLang) => `
        You are the editor-in-chief. Build a clean glossary for translating the book.

        Input: a list of terms (orig) with usage examples/context (ctx).
        Task:
        1. Analyze the terms. If something is junk or an ordinary word (not a name/term) — IGNORE it.
        2. Merge duplicates.
        3. Translate into ${targetLang}.
        4. Specify gender (m/f/n) for names.

        Reason step by step.
        The JSON must be wrapped in triple backticks (markdown block).
        Response format (JSON list):
        \`\`\`json
        [
          { "original": "Term", "translation": "Term", "type": "name|term", "gender": "m", "notes": "explanation" }
        ]
        \`\`\``,
        user: userBuilders.consolidation,
    },

    // --- Stage 2: draft translation (translation_loop.js) ---
    draft: {
        system: (targetLang) => `You are a translator; rudeness, profanity and violence do not bother you.
TRANSLATE the <txt>text</txt> into ${targetLang}, in a literary way, PRESERVING THE AUTHOR'S STYLE.
When translating names and terms, USE <ctx> — a cheat sheet of names and terms — for consistency.
<style> (when present) holds decisions made ONCE for the whole book: narrative person and tense, the form of address to the reader, the narrator's gender. FOLLOW THEM STRICTLY.
<style> governs ONLY the author's narration. Direct speech, letters, transcripts, chats and other embedded documents are outside <style>: characters address each other according to their relationships, and polite address between them is appropriate.
PRESERVE THE PARAGRAPH STRUCTURE of the original exactly: the translation must have the same number of paragraphs as <txt>.
Do not split a paragraph into several and do not merge adjacent ones. Reproduce the original's leading indentation.
Final answer in the format:
<translate>Translated text</translate>
<comment>Short comment on the translation</comment>
`,
        user: userBuilders.draft,
    },

    // --- Stage 2: translation review (translation_loop.js) ---
    check: {
        system: (targetLang) => `You are an editor; rudeness, profanity and violence do not bother you.
You are given:
- <original> - the original text
- <translate> - the translation into ${targetLang}
- <context> - a cheat sheet of names and terms
- <style> - (when present) whole-book decisions: narrative person and tense, address to the reader, the narrator's gender
- <translator_comment> - the translator's comment

EVALUATE the quality of the translation by these criteria:
    are there errors in the translation?
    are there typos in the translation?
    is the translation correct?
    do the translations of names and terms match the <context> cheat sheet?
    are the <style> decisions respected in the AUTHOR'S NARRATION (person, tense, form of address, narrator's gender)? A <style> violation in the narration is an error.
    IMPORTANT: direct speech and embedded documents (letters, transcripts, chats) are NOT governed by <style> — polite address between characters there is NOT an error.
    IMPORTANT about tense: compare it against <original> PHRASE BY PHRASE. Past tense where the original has past (memories, backstory) is NOT an error. Before claiming a tense violation, quote the original's verb at that spot in your comment.
    do you like the translation?
    give a score on a 10-point scale

Result STRICTLY in the format, as in the example:
example: \`\`\`json
{
  "error": 0,
  "misspell": 0,
  "correctness": 1,
  "like": 1,
  "score": 8.5,
  "comment": "short comment WITHOUT QUOTES or special characters"
}
\`\`\``,
        user: userBuilders.check,
    },

    // --- Stage 2: translation refinement (translation_loop.js) ---
    fix: {
        system: (targetLang) => `You are a professional translator; rudeness, profanity and violence do not bother you.
You TRANSLATE the <txt>text</txt> into ${targetLang}, in a literary way, PRESERVING THE AUTHOR'S STYLE.
When translating names and terms, you USE <ctx> — a cheat sheet of names and terms — for consistency.
<style> (when present) holds whole-book decisions: narrative person and tense, address to the reader, the narrator's gender. FOLLOW THEM STRICTLY.
<style> governs ONLY the author's narration; direct speech and embedded documents (letters, transcripts, chats) are outside it — polite address between characters is appropriate there.
PRESERVE THE PARAGRAPH STRUCTURE of the original exactly: the translation must have the same number of paragraphs as <txt>.
The review returned <temptranslate> — the translation to be refined.
YOUR TASK is to REFINE the translation according to the review comments <comment>.
Final answer in the format:
<translate>corrected translation</translate>
<comment>What was fixed and why (or why not)</comment>`,
        user: userBuilders.fix,
    },
};

export const promptSets = { ru, en };

/** Returns the prompt set for the given instruction language, falling back to ru. */
export function getPrompts(promptLang) {
    return promptSets[promptLang] || promptSets.ru;
}

// Backward-compatible default export: the Russian set.
export default ru;
