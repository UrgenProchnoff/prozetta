
import fs from 'fs';
import cliProgress from 'cli-progress'; // Добавляем прогресс-бар
import { fromPreTrained } from "@lenml/tokenizer-gemma3";
import { HumanMessage } from "@langchain/core/messages";


// Константы 
// контекст 16к
const TOKENS_LIMIT_1 = 500;         // лимит 1
let TOKENS_LIMIT_2 = 500;            // лимит 2

//const NAME = 'Powrot';
const NAME = 'Sterling_Junk_DNA';

const FILE_NAME = NAME + '.txt';
const FILE_NAME_RUS = NAME + '_RUS6' + '.txt';
const FILE_NAME_JSON = NAME + '_progress.json';


/*
import { ChatGroq } from "@langchain/groq";
const model = new ChatGroq({
  apiKey: 'gsk',
  model: "llama-3.3-70b-versatile",
  //model: "llama3-70b-8192",
  //model: "llama-3.2-90b-text-preview",
  temperature: 0.7,
  maxTokens: MAX_TOKENS_PER_REQUEST,

});
*/

///*
import { ChatOpenAI } from "@langchain/openai";
const model = new ChatOpenAI({
  apiKey: "...",
  model: "gpt-4",
  configuration: {
    baseURL: "http://127.0.0.1:8007/v1",
    //timeout: 600000,
    //maxTokens: 2000,
    temperature: 0.7,

  },
});
//*/

/*
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
const model = new ChatGoogleGenerativeAI({
  model: "gemma-3-27b-it",
  temperature: 0.6,

});
*/



let main_structure = {
  current_chunk: 0,
  total_chunk: 0,
  global_context: '', //контекст по уже переведённому тексту
  global_context_tokens: 0,
  global_tokens_in: 0,
  global_tokens_out: 0,
  chunks: [],
  timestamp: 0,
};


let tokenizer = fromPreTrained();
// Функция подсчета токенов с фолбэком
function countTokens(text) {
  try {
    let encoded = tokenizer.encode(text);
    return encoded.length;
  } catch (error) {
    console.error("Ошибка при токенизации, используем фолбэк (1 слово ~ 1.3 токена):", error.message);
    // Грубая оценка: длина текста / 3 (примерно 1 токен на 3-4 символа для английского/кода, 
    // для кириллицы может быть иначе, но это лучше чем краш)
    // Или по пробелам:
    return Math.ceil(text.length / 3);
  }
}




function splitTextIntoChunks(text) {
  console.log('splitTextIntoChunks');
  let base_fragment = '';
  let raw_additional_fragment = '';
  let target_fragment = '';
  let flag_base_fragment = 0;

  const lines = text.split('\n');
  console.log('lines: ', lines.length);

  //base_fragment = lines[0];
  for (let i = 0; i < lines.length; i++) {

    //console.log('countTokens base_fragment: ', countTokens(base_fragment));
    if (countTokens(base_fragment) >= TOKENS_LIMIT_1) {
      flag_base_fragment = 1;
      //break;
      //console.log('TOKENS_LIMIT_1 base_fragment: ', base_fragment);
    }

    if (flag_base_fragment == 0) {
      base_fragment += lines[i] + '\n';
      //console.log('base_fragment: ', base_fragment);
    }
    else {
      raw_additional_fragment += lines[i] + '\n';

    }

    if (countTokens(raw_additional_fragment) >= TOKENS_LIMIT_2) {
      let split_fragment = splitFragment(raw_additional_fragment);
      //console.log('base_fragment: ', base_fragment);
      //console.log('split_fragment: ', split_fragment);
      target_fragment = base_fragment;
      target_fragment += split_fragment.base_fragment;
      base_fragment = split_fragment.additional_fragment;
      raw_additional_fragment = '';
      flag_base_fragment = 0;
      main_structure.chunks.push(
        {
          original: target_fragment,     //текст оригинал
          translate: "",    //перевод
          tokens_original: countTokens(target_fragment),
          tokens_translate: 0,
          tokens_in: 0,   // потрачено
          tokens_out: 0,
        });
    }
  }
  main_structure.total_chunk = main_structure.chunks.length;
}



function splitFragment(fragment) {
  //console.log('splitFragment: ', fragment);
  let split_fragment = {
    base_fragment: '',
    additional_fragment: '',
  }
  const lines = fragment.split('\n');
  let empty_lines_max =
  {
    max: 0,
    max_index: 0,
    count: 0,
  }
  let point_end_index = 0;
  let paragraph_index = -1;

  console.log('lines.length: ', lines.length);
  for (let i = 0; i < lines.length - 1; i++) {
    //console.log('lines i: ', i);
    //console.log('lines[i]: ', lines[i]);
    //console.log(' ');

    if (lines[i].replace(/[\r\n\t\v\f\x00-\x1F]+/g, '') === '') { // строка пустая
      empty_lines_max.count++;
      //console.log('empty_lines_max.count++  =', i);
      //console.log('lines  =', lines[i]);
    }
    else {   // строка не пустая
      if (empty_lines_max.max < empty_lines_max.count) {
        empty_lines_max.max = empty_lines_max.count;
        empty_lines_max.max_index = i - 1;
      }
      empty_lines_max.count = 0;
    }

    // сторока заканчивается . или ."
    if (lines[i].replace(/[\r\n\t\v\f\x00-\x1F]+/g, '').endsWith('.') ||
      lines[i].replace(/[\r\n\t\v\f\x00-\x1F]+/g, '').endsWith('."')) {
      point_end_index = i;
      //console.log('point_end_index =', i);
      //console.log('lines  =', lines[i]);

    }

    // строка начинается с пробелов или таб, начало нового абзаца
    if (checkIndentation(lines[i])) {
      paragraph_index = i;
      //console.log('paragraph_index =', i);
      //console.log('lines  =', lines[i]);

    }
  }

  //console.log('empty_lines_max: ', empty_lines_max);
  //process.exit(1);
  if (empty_lines_max.count > 0) {
    for (let i = 0; i < lines.length; i++) {
      if (i <= empty_lines_max.max_index) {
        split_fragment.base_fragment += lines[i] + '\n';
      }
      else {
        split_fragment.additional_fragment += lines[i] + '\n';
      }
    }
    return split_fragment;
  }

  //console.log('paragraph_index: ', paragraph_index);
  //
  if (paragraph_index > -1) {
    for (let i = 0; i < lines.length; i++) {
      if (i <= paragraph_index - 1) {
        split_fragment.base_fragment += lines[i] + '\n';
      }
      else {
        split_fragment.additional_fragment += lines[i] + '\n';
      }
    }
    return split_fragment;

  }

  //console.log('point_end_index: ', point_end_index);
  if (point_end_index > 0) {
    for (let i = 0; i < lines.length; i++) {
      if (i <= point_end_index) {
        split_fragment.base_fragment += lines[i] + '\n';
      }
      else {
        split_fragment.additional_fragment += lines[i] + '\n';
      }
    }
    return split_fragment;
  }

  //process.exit(1);
  split_fragment.base_fragment = fragment;
  return split_fragment;
}


function checkIndentation(line) {
  if (typeof line !== 'string' || line.length === 0) {
    return 0; // Возвращаем 0 для нестроковых или пустых входных данных
  }
  if (line.startsWith('\t')) {
    return 1; // Начинается с табуляции
  }
  if (line.startsWith('  ') && line.trim().length > 0) {
    let count = 0;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === ' ') {
        count++;
      } else {
        break;
      }
    }
    if (count >= 2) {
      return 1; // Начинается с двух или более пробелов
    }
  }

  return 0; // Не начинается ни с табуляции, ни с двух или более пробелов
}


async function translateTextCycle(inputFile, outputFile) {
  let startChunk = 0;

  console.log('translateTextCycle');
  // Пытаемся загрузить сохраненный прогресс
  if (fs.existsSync(FILE_NAME_JSON)) {
    try {
      const savedProgress = JSON.parse(fs.readFileSync(FILE_NAME_JSON));
      if (savedProgress.chunks?.length > 0) {
        main_structure = savedProgress;
        startChunk = main_structure.current_chunk;
        console.log(`Восстановление с чанка ${main_structure.current_chunk}`);
      }
    } catch (e) {
      console.error('Ошибка загрузки прогресса:', e);
    }
  }
  else {
    const text = fs.readFileSync(inputFile).toString();
    splitTextIntoChunks(text);
    //console.log('main_structure = ', main_structure);


  }


  const progressBar = new cliProgress.SingleBar({
    format: 'Перевод |{bar}| {percentage}% | {value}/{total} чанков | {status}',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true
  });

  progressBar.start(main_structure.chunks.length, startChunk, {
    status: startChunk > 0 ? 'Продолжаем перевод...' : 'Начало перевода...'
  });

  for (let i = startChunk; i < main_structure.chunks.length; i++) {
    try {

      let checkCtxResponse = {
        successfully: 0,
        tokens_in: 0,
        tokens_out: 0,
      }
      let newCtxResponse = {
        content: '',
        tokens_in: 0,
        tokens_out: 0,
      }


      // Обновляем контекст
      progressBar.update(i, { status: 'Извлечение нового контекста...' });
      // получаем новый контекст
      newCtxResponse = await contextRetrive(progressBar);
      console.log('newCtxResponse = ', newCtxResponse);

      main_structure.chunks[i].tokens_in += newCtxResponse.tokens_in;
      main_structure.chunks[i].tokens_out += newCtxResponse.tokens_out;
      progressBar.update(i, { status: ' Проверка контекста...' });

      checkCtxResponse = await contextCheck(progressBar, newCtxResponse.content);
      console.log('checkCtxResponse = ', checkCtxResponse);
      main_structure.chunks[i].tokens_in += checkCtxResponse.tokens_in;
      main_structure.chunks[i].tokens_out += checkCtxResponse.tokens_out;
      if (checkCtxResponse.success === undefined) {
        checkCtxResponse.success = 0;
      }
      do {
        if (checkCtxResponse.success === 0) {
          progressBar.update(i, { status: ' Доработка контекста...' });
          newCtxResponse = await contextFixing(progressBar, newCtxResponse.content, checkCtxResponse.comment);
          console.log('newCtxResponse = ', newCtxResponse);
          main_structure.chunks[i].tokens_in += newCtxResponse.tokens_in;
          main_structure.chunks[i].tokens_out += newCtxResponse.tokens_out;

          progressBar.update(i, { status: ' Проверка контекста...' });
          checkCtxResponse = await contextCheck(progressBar, newCtxResponse.content);
          console.log('checkCtxResponse = ', checkCtxResponse);
          main_structure.chunks[i].tokens_in += checkCtxResponse.tokens_in;
          main_structure.chunks[i].tokens_out += checkCtxResponse.tokens_out;
          if (checkCtxResponse.success === undefined) {
            checkCtxResponse.success = 0;
          }



        }
      }
      // проверяем новый контекст      
      while (checkCtxResponse.success == 0);
      // обновляем общий контекст
      main_structure.global_context += '\n' + newCtxResponse.content;
      main_structure.global_context_tokens = countTokens(main_structure.global_context);

      let translatedResponse = {
        content: '',
        tokens_in: 0,
        tokens_out: 0,
      }
      let checkTranslateResponse = {
        successfully: 0,
        tokens_in: 0,
        tokens_out: 0,
      }


      let flag_need_fix = 0;
      let comment = '';
      do {

        if (flag_need_fix == 1) {
          //Доработка перевода текста
          progressBar.update(i, { status: 'Доработка перевода фрагмента...' });
          translatedResponse = await translateFixText(progressBar, 3, translatedResponse.content, comment);
          console.log('translatedResponse = ', translatedResponse);
          main_structure.chunks[i].tokens_in += translatedResponse.tokens_in;
          main_structure.chunks[i].tokens_out += translatedResponse.tokens_out;

        } else {
          // Переводим текст
          progressBar.update(i, { status: 'Перевод фрагмента...' });
          translatedResponse = await translateText(progressBar);
          console.log('translatedResponse = ', translatedResponse);
          main_structure.chunks[i].tokens_in += translatedResponse.tokens_in;
          main_structure.chunks[i].tokens_out += translatedResponse.tokens_out;


        }
        progressBar.update(i, { status: ' Проверка качества перевода...' });
        checkTranslateResponse = await traslateCheck(progressBar, translatedResponse.content);
        console.log('checkTranslateResponse = ', checkTranslateResponse);
        main_structure.chunks[i].tokens_in += checkTranslateResponse.tokens_in;
        main_structure.chunks[i].tokens_out += checkTranslateResponse.tokens_out;
        if (checkTranslateResponse.success === undefined) {
          checkTranslateResponse.success = 0;
        }
        if (checkTranslateResponse.success == 0 && checkTranslateResponse.like == 1) {
          flag_need_fix = 1;
          comment = checkTranslateResponse.comment;
        }
        else { flag_need_fix = 0; }

      }
      // проверяем новый перевод      
      while (checkTranslateResponse.success == 0);
      main_structure.chunks[i].translate = translatedResponse.content;
      main_structure.current_chunk++;




      // Сохраняем в файл перевода
      fs.appendFileSync(outputFile, main_structure.chunks[i].translate);
      // Сохраняем прогресс после каждого успешного перевода
      saveProgress();
      progressBar.update(i + 1, { status: 'Готово' });
      await new Promise(resolve => setTimeout(resolve, 100));


    } catch (error) {
      progressBar.stop();
      console.error(`\nОшибка перевода чанка ${i + 1}:`, error.message);

      // Сохраняем прогресс при ошибке
      saveProgress();

      throw error;
    }
  }

  progressBar.stop();

}


// Функция извлечения контекста
async function contextRetrive(progressBar, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      let input =
        `<ctx>${main_structure.global_context}</ctx>
<txt>${main_structure.chunks[main_structure.current_chunk].original}</txt>`;
      // console.log('input1 = ', input);

      let promt = `
        Ты - переводчик. 
        Твоя задача - извлечь и КАЧЕСТВЕННО ПЕРЕВЕСТИ/АДАПТИРОВАТЬ из <txt> все **новые** имена персонажей и **неочевидные** термины (с указанием пола). 
        **новые** - значит, отсутствующие в <ctx>.
        **неочевидные** - те которые могут быть переведены по разному разными переводчиками, например придуманные автором или редкие.
        Это нужно для единообразия перевода.
      
        **Формат результата:**
        оригинальное имя/термин перевод тип (примечание) пол
        Примеры:
        Marc Марк имя пол мужской
        Orphids Орфиды термин (разновидность наномашин) пол женский
        
        **Важно:**
        - Следи за корректностью русских окончаний в зависимости от пола персонажа или пола адаптировнного термина.
        - Рассуждай шаг за шагом, ответ в **строго** указанном формате.
     
    **Формат ответа:**
     `+ "```json" +
        `{
      "content": "
       Marc Марк имя пол мужской
       Orphids Орфиды термин (разновидность наномашин) пол женский
       ",
       "comment": "комментарий к результату"
     }`+ "````";
      //console.log('promt = ', promt);

      let fullResponse = "";
      let tokenIn = 0;
      let tokenOut = 0;
      for await (const chunk of await model.stream(
        [
          new HumanMessage(promt),
          new HumanMessage(input),

        ]
      )) {
        //console.log('chunk = ', chunk);
        fullResponse += chunk.content;
        tokenIn += chunk.response_metadata?.usage?.prompt_tokens || 0;
        tokenOut += chunk.response_metadata?.usage?.completion_tokens || 0;
      }

      console.log('fullResponse: ', fullResponse);
      console.log('tokenIn = ', tokenIn);
      console.log('tokenOut = ', tokenOut);

      main_structure.global_tokens_in += tokenIn;
      main_structure.global_tokens_out += tokenOut;
      let stringJson = extractFromJsonTags(fullResponse, 'json');
      let dataJson = validateLLMJson(stringJson);

      return {
        content: dataJson.data.content,
        tokens_in: tokenIn,
        tokens_out: tokenOut,
      }
    } catch (error) {
      console.error(`Attempt ${i + 1} failed:`, error.message);
      if (i < retries - 1) {
        progressBar.update(null, { status: `Retry ${i + 1}/${retries}...` });
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        continue;
      }
      throw error;
    }
  }
}


// Функция проверки извлечения контекста
async function contextCheck(progressBar, newctx, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      let input = `<ctx>${main_structure.global_context}</ctx>
        <txt>${main_structure.chunks[main_structure.current_chunk].original}</txt>
        <newctx>${newctx}</newctx>`;

      let promt = `Твоя задача — оценить качество ИЗВЛЕЧЕНИЯ и ПЕРЕВОДА нового контекста.  Я предоставлю тебе три фрагмента текста:
     
     1.  **<ctx> (Глобальный контекст):** Это уже извлеченные и проверенные имена персонажей и термины, которые должны использоваться единообразно во всем тексте.
     2.  **<txt> (Текущий фрагмент):** Это фрагмент текста, из которого нужно извлечь новые имена и новые неочевидные термины.
     3.  **<newctx> (Новый контекст):** Это результат работы по извлечению новых имен и терминов из <txt>.

     пояснения:
      **новые** - значит, отсутствующие в <ctx>.
      **неочевидные** - те которые могут быть переведены по разному разными переводчиками, например придуманные автором или редкие.
      НЕНАДО придираться к терминам которые по другому не переведёшь.
      
         
     Твоя задача — проверить, насколько хорошо был извлечен и переведён новый контекст <newctx> из <txt>, учитывая уже имеющийся <ctx>. Оцени это по следующим критериям:
     
     **Критерии оценки:**
     
     *   **Извлечение (extraction):** Все ли НОВЫЕ имена персонажей и НОВЫЕ **неочевидные термины**, которые есть в <txt>, были извлечены и добавлены в <newctx>?
         *   Если все, поставь **1**.
         *   Если не все, поставь **0**.
               
     *   **Качество (quality):** Качественно ли переведены термины и имена?
         *   Если считаешь что качественно, поставь **1**.
         *   Если думаешь что можно лучше, поставь **0**.
           
     *   **Форматирование (format):** Правильно ли отформатирован <newctx>?
         *   Если формат <newctx> **корректен**, поставь **1**.
         *   Если формат <newctx> **некорректен**, поставь **0**.
     
     **Требования к формату <newctx>:**
     * Каждая строка должна содержать информацию об одном имени или термине.
     * Строка должна содержать:
         * Оригинальное имя/термин (на языке оригинала).
         * Переведенное имя/термин (на русском языке).
         * Тип (имя, термин),  дополнительная информация(опцонально), пол.
     * Пример: 'Marc Марк имя пол мужской'
     * Пример: 'Orphids Орфиды термин (разновидность наномашин) пол женский'
     
     Рассуждай шаг за шагом, ответ в **строго** указанном формате.
     
    **Формат ответа:**
       
     `+ "```json" +
        `{
       "extraction": 1,
       "format": 1,
       "quality": 1,
       "comment": "комментарий к результату"
     }`+ "````";


      let fullResponse = "";
      let tokenIn = 0;
      let tokenOut = 0;
      // Используем model.stream() для получения ответа по частям
      for await (const chunk of await model.stream(
        [
          new HumanMessage(promt),
          new HumanMessage(input),
        ]
      )) {
        fullResponse += chunk.content;
        // Считаем токены из метаданных чанка
        tokenIn += chunk.response_metadata?.usage?.prompt_tokens || 0;
        tokenOut += chunk.response_metadata?.usage?.completion_tokens || 0;
      }


      console.log("contextCheck fullResponse: ", fullResponse);
      console.log("contextCheck tokenIn: ", tokenIn);
      console.log("contextCheck tokenOut: ", tokenOut);

      main_structure.global_tokens_in += tokenIn;
      main_structure.global_tokens_out += tokenOut;

      let stringJson = extractFromJsonTags(fullResponse, 'json');
      let dataJson = validateLLMJson(stringJson);

      let successfully = dataJson.data.extraction && dataJson.data.format && dataJson.data.quality;
      console.log("checkCTX.comment = ", dataJson.data.comment);


      return {
        success: successfully,
        tokens_in: tokenIn,
        tokens_out: tokenOut,
        comment: dataJson.data.comment,
      };
    } catch (error) {
      console.error(`Attempt ${i + 1} failed:`, error.message);
      if (i < retries - 1) {
        progressBar.update(null, { status: `Retry ${i + 1}/${retries}...` });
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        continue;
      }
      throw error;
    }
  }
}




// Функция доработки контекста
async function contextFixing(progressBar, tempctx, comment, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      let input = `
      <txt>${main_structure.chunks[main_structure.current_chunk].original}</txt>
      <ctx>${main_structure.global_context}</ctx><
      tempctx>${tempctx}</tempctx>
      <comment>${comment}</comment>`;
      console.log('input translateText = ', input);


      let promt = `
    Наша задача - извлечь из <txt> все **новые** имена персонажей и **неочевидные** термины (с указанием пола). 
        **новые** - значит, отсутствующие в <ctx>.
        **неочевидные** - те которые могут быть переведены по разному разными переводчиками, например придуманные автором или редкие.
        Это нужно для единообразия перевода.
      
        **Формат результата (строго):**
        оригинальное имя/термин перевод тип (примечание) пол
        Примеры:
        Marc Марк имя пол мужской
        Orphids Орфиды термин (разновидность наномашин) пол женский
      
    
    Я предоставлю тебе четыре фрагмента текста:
     1.  **<txt> (Текущий фрагмент):** Это фрагмент текста, из которого нужно извлечь новые имена и новые неочевидные термины.
     2.  **<ctx> (Глобальный контекст):** Это уже извлеченные и проверенные имена персонажей и термины, которые должны использоваться единообразно во всем тексте.
     3.  **<tempctx> (Новый Временный контекст):** Это результат работы по извлечению новых имен и терминов из <txt>, этот вариант был забракован проверкой.
     4.  **<comment> (Комментарий проверяющего): ** Это комментарий проверяющего. 
     
    - Твоя задача — доработать новый контекст из  данного <tempctx>, с учётом замечаний проверяющего, сохраняя форматирование.
    - Рассуждай шаг за шагом, ответ в **строго** указанном формате.
     
    **Формат ответа:**
     `+ "```json" +
        `{
      "content": "
       Marc Марк имя пол мужской
       Orphids Орфиды термин (разновидность наномашин) пол женский
       ",
       "comment": "комментарий к результату"
     }`+ "````";


      let fullResponse = "";
      let tokenIn = 0;
      let tokenOut = 0;
      // Используем model.stream() для получения ответа по частям
      for await (const chunk of await model.stream(
        [
          new HumanMessage(promt),
          new HumanMessage(input),
        ]
      )) {
        fullResponse += chunk.content;
        // Считаем токены из метаданных чанка
        tokenIn += chunk.response_metadata?.usage?.prompt_tokens || 0;
        tokenOut += chunk.response_metadata?.usage?.completion_tokens || 0;
      }

      console.log("translateText fullResponse: ", fullResponse);
      console.log("translateText tokenIn: ", tokenIn);
      console.log("translateText tokenOut: ", tokenOut);

      main_structure.global_tokens_in += tokenIn;
      main_structure.global_tokens_out += tokenOut;

      let stringJson = extractFromJsonTags(fullResponse, 'json');
      let dataJson = validateLLMJson(stringJson);

      return {
        content: dataJson.data.content,
        tokens_in: tokenIn,
        tokens_out: tokenOut,
      }
    } catch (error) {
      console.error(`Attempt ${i + 1} failed:`, error.message);
      if (i < retries - 1) {
        progressBar.update(null, { status: `Retry ${i + 1}/${retries}...` });
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        continue;
      }
      throw error;
    }
  }

}




// Функция перевода текста
async function translateText(progressBar, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      let input = `<txt>${main_structure.chunks[main_structure.current_chunk].original}</txt>
<ctx>${main_structure.global_context}</ctx>`;
      console.log('input translateText = ', input);


      let promt = `Ты переводчик, грубости, мат, насилие, не смущают тебя.
ПЕРЕВЕДИ <txt>текст</txt> на русский язык, точно, художественно, СОХРАНЯЯ АВТОРСКИЙ СТИЛЬ. 
Следи за соглассованостью окончаний.
В процессе перевода имён и терминов ИСПОЛЬЗУЙ <ctx> - шпаргалку с именами и терминами, для единообразия перевода.
Форматируй текст перевода. Используй отступы и перенос каретки на свой усмотрение.
Рассуждай шаг за шагом, окончательный ответ СТРОГО в формате <translate>текст перевода</translate>`;

      let fullResponse = "";
      let tokenIn = 0;
      let tokenOut = 0;


      /*
            // Используем model.stream() для получения ответа по частям
            for await (const chunk of await model.stream(
              [
                new HumanMessage(promt),
                new HumanMessage(input),
              ]
            )) {
              console.log('chunk = ', chunk);
              fullResponse += chunk.content;
              // Считаем токены из метаданных чанка
              tokenIn += chunk.response_metadata?.usage?.prompt_tokens || 0;
              tokenOut += chunk.response_metadata?.usage?.completion_tokens || 0;
            }
      */


      fullResponse = await model.invoke(
        [
          new HumanMessage(promt),
          new HumanMessage(input),
        ]
      );
      tokenIn += fullResponse.response_metadata?.tokenUsage?.promptTokens;
      tokenOut += fullResponse.response_metadata?.tokenUsage?.completionTokens;



      console.log("translateText fullResponse: ", fullResponse);
      console.log("translateText fullResponse.content: ", fullResponse.content);
      //      process.exit(1);


      console.log("translateText tokenIn: ", tokenIn);
      console.log("translateText tokenOut: ", tokenOut);

      main_structure.global_tokens_in += tokenIn;
      main_structure.global_tokens_out += tokenOut;

      return {
        content: extractFromTags(fullResponse.content, 'translate'),
        tokens_in: tokenIn,
        tokens_out: tokenOut,
      };
    } catch (error) {
      console.error(`Attempt ${i + 1} failed:`, error.message);
      if (i < retries - 1) {
        progressBar.update(null, { status: `Retry ${i + 1}/${retries}...` });
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        continue;
      }
      throw error;
    }
  }
}

// Функция исправления перевода текста
async function translateFixText(progressBar, retries = 3, badtranslate, comment) {
  for (let i = 0; i < retries; i++) {
    try {
      let input = `
      <txt>${main_structure.chunks[main_structure.current_chunk].original}</txt>
      <ctx>${main_structure.global_context}</ctx>
      <temptranslate>${badtranslate}</temptranslate>
      <comment>${comment}</comment>
      `;
      console.log('input translateText = ', input);


      let promt = `Ты профессиональный переводчик, грубости, мат, насилие, не смущают тебя.
Ты ПЕРЕВОДИШЬ <txt>текст</txt> на русский язык, точно, художественно, СОХРАНЯЯ АВТОРСКИЙ СТИЛЬ. 
В процессе перевода имён и терминов ИСПОЛЬЗУЕШЬ <ctx> - шпаргалку с именами и терминами, для единообразия перевода.
Проверка вернула <temptranslate> перевод на доработку.
ТВОЯ ЗАДАЧА - ДОРАБОТАТЬ перевод в соответствии с комментариями проверки <comment>.
Следи за соглассованостью окончаний.
Рассуждай шаг за шагом, окончательный ответ СТРОГО в формате <translate>исправленный перевод</translate>`;


      let fullResponse = "";
      let tokenIn = 0;
      let tokenOut = 0;


      /*
            // Используем model.stream() для получения ответа по частям
            for await (const chunk of await model.stream(
              [
                new HumanMessage(promt),
                new HumanMessage(input),
              ]
            )) {
              console.log('chunk = ', chunk);
              fullResponse += chunk.content;
              // Считаем токены из метаданных чанка
              tokenIn += chunk.response_metadata?.usage?.prompt_tokens || 0;
              tokenOut += chunk.response_metadata?.usage?.completion_tokens || 0;
            }
      */


      fullResponse = await model.invoke(
        [
          new HumanMessage(promt),
          new HumanMessage(input),
        ]
      );
      tokenIn += fullResponse.response_metadata?.tokenUsage?.promptTokens;
      tokenOut += fullResponse.response_metadata?.tokenUsage?.completionTokens;



      console.log("translateText fullResponse: ", fullResponse);
      console.log("translateText fullResponse.content: ", fullResponse.content);
      //      process.exit(1);


      console.log("translateText tokenIn: ", tokenIn);
      console.log("translateText tokenOut: ", tokenOut);

      main_structure.global_tokens_in += tokenIn;
      main_structure.global_tokens_out += tokenOut;

      return {
        content: extractFromTags(fullResponse.content, 'translate'),
        tokens_in: tokenIn,
        tokens_out: tokenOut,
      };
    } catch (error) {
      console.error(`Attempt ${i + 1} failed:`, error.message);
      if (i < retries - 1) {
        progressBar.update(null, { status: `Retry ${i + 1}/${retries}...` });
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        continue;
      }
      throw error;
    }
  }
}


// Функция проверки перевода
async function traslateCheck(progressBar, translateText, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      let input = `<context>${main_structure.global_context}</context>
        <original>${main_structure.chunks[main_structure.current_chunk].original}</original>
        <translate>${translateText}</translate>`;

      let promt = `Ты благосклонный редактор, грубости, мат, насилие, не смущают тебя.  
ОЦЕНИ качество перевода по следующим критериям:
    в переводе есть ошибки?
    в переводе есть опечатки?
    перевод корректен? 
    перевод тебе нравится?
    поставь оценку по 10 бальной шкале
Рассуждай шаг за шагом. Не докапывайся до мелочей!!!
Результат СТРОГО в формате, как в примере:
пример: `+
        "```json" +
        `{
  "error": 0,
  "misspell": 0,
  "correctness": 1,
  "like": 1,
  "score": 8.5
  "comment": "комментарий к результату",
}` +
        "````";


      let fullResponse = "";
      let tokenIn = 0;
      let tokenOut = 0;
      // Используем model.stream() для получения ответа по частям
      for await (const chunk of await model.stream(
        [
          new HumanMessage(promt),
          new HumanMessage(input),
        ]
      )) {
        fullResponse += chunk.content;
        // Считаем токены из метаданных чанка
        tokenIn += chunk.response_metadata?.usage?.prompt_tokens || 0;
        tokenOut += chunk.response_metadata?.usage?.completion_tokens || 0;
      }

      console.log("traslateCheck fullResponse: ", fullResponse);
      console.log("traslateCheck tokenIn: ", tokenIn);
      console.log("traslateCheck tokenOut: ", tokenOut);

      main_structure.global_tokens_in += tokenIn;
      main_structure.global_tokens_out += tokenOut;

      let stringJson = extractFromJsonTags(fullResponse, 'json');
      console.log("checkTranslate fullResponse = ", fullResponse);
      let dataJson = validateLLMJson(stringJson);
      let successfully = !dataJson.data.error && !dataJson.data.misspell && dataJson.data.correctness && dataJson.data.like;
      console.log("checkTranslate.comment = ", dataJson.data.comment);

      if (successfully == 0 && dataJson.data.like && dataJson.data.score >= 9.1) {
        successfully = 1;
      }

      return {
        success: successfully,
        like: dataJson.data.like,
        comment: dataJson.data.comment,
        tokens_in: tokenIn,
        tokens_out: tokenOut,
      };
    } catch (error) {
      console.error(`Попытка ${i + 1} не удалась:`, error.message);
      if (i < retries - 1) {
        progressBar.update(null, { status: `Повторная попытка ${i + 1}/${retries}...` });
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        continue;
      }
      throw error;
    }
  }
}




// Функция сохранения прогресса
function saveProgress() {
  main_structure.timestamp = new Date().toISOString()
  // Используем atomic запись через временный файл
  const tempFile = 'translation_progress.tmp.json';
  fs.writeFileSync(tempFile, JSON.stringify(main_structure, null, 2));
  fs.renameSync(tempFile, FILE_NAME_JSON);
}


function validateLLMJson(jsonString) {
  // Базовая проверка формата
  let data;
  try {
    data = JSON.parse(jsonString);
  } catch (e) {
    //return { valid: false, error: "Invalid JSON syntax" };
    throw new Error(`Invalid JSON syntax: ${e.message}`);
  }

  // Проверка на обрезанный JSON (часто встречается в выводе LLM)
  const openBraces = (jsonString.match(/{/g) || []).length;
  const closeBraces = (jsonString.match(/}/g) || []).length;
  if (openBraces !== closeBraces) {
    //return { valid: false, error: "Unbalanced braces, possible truncation" };
    throw new Error("Unbalanced braces, possible truncation");
  }

  // Проверка специфичных полей или структуры
  return { valid: true, data };
}



function extractFromTags(response, tag) {
  let r = response;
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'g');
  const matches = [...r.matchAll(regex)];
  //console.log('matches:', matches);
  if (matches.length === 0) {
    throw new Error(`Теги <${tag}> не найдены в ответе.`);
  }
  if (matches.length > 1) {
    throw new Error(`В ответе найдено несколько пар тегов <${tag}>.`);
  }
  let out = matches[0][1].trim();
  //console.log('out:', out);
  return out;
}


function extractFromJsonTags(response, tag = '') {
  // Regex to match ```json ... ``` or just ``` ... ```
  const regex = new RegExp('```' + (tag ? tag + '\\s*' : '') + '([\\s\\S]*?)```', 'g');
  const matches = [...response.matchAll(regex)];

  console.log('matches:', matches);

  if (matches.length === 0) {
    throw new Error(`Блоки \`\`\`${tag}\`\`\` не найдены в ответе.`);
  }

  if (matches.length > 1) {
    throw new Error(`В ответе найдено несколько блоков \`\`\`${tag}\`\`\`.`);
  }

  return matches[0][1].trim();
}


// Функция запуска перевода с улучшенным восстановлением
async function startTranslation(inputFile, outputFile) {
  try {
    console.log('Начинаем перевод...');


    // Проверяем существующий прогресс
    if (fs.existsSync(FILE_NAME_JSON)) {
      const progress = JSON.parse(fs.readFileSync(FILE_NAME_JSON));
      console.log(`Найден прогресс:
  - Переведено: ${progress.current_chunk}/${progress.total_chunk} чанков
  - Последнее обновление: ${new Date(progress.timestamp).toLocaleString()}
  `);
    }

    await translateTextCycle(inputFile, outputFile);
    console.log('\nПеревод успешно завершен');

    // Удаляем файл прогресса после успешного завершения
    //if (fs.existsSync(FILE_NAME_JSON)) {fs.unlinkSync(FILE_NAME_JSON); }

  } catch (error) {
    console.error('\nОшибка перевода:', error.message);
    process.exit(1);
  }
}

startTranslation(FILE_NAME, FILE_NAME_RUS);
