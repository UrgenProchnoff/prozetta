/**
 * The translation loop end to end, with a scripted model in place of a real one.
 *
 * Everything the loop decides — approve, fix, redraft, call a dispute, skip a
 * refused chunk — it decides from what the model answered, so a model that
 * answers from a script exercises every branch without a network or a key.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src_v4/config.js';
import { llmManager } from '../src_v4/core/llm_client.js';
import { ProjectState } from '../src_v4/core/state_manager.js';
import { getPrompts } from '../src_v4/prompts.js';
import { runTranslationLoopStage } from '../src_v4/stages/translation_loop.js';
import { tempWorkDir, silenceConsole, verdict, answer } from './helpers.js';

let prompts, signature;

before(() => {
    silenceConsole();
    // The thresholds are settings, and a developer's own overrides file must
    // not decide whether the tests pass.
    Object.assign(config.pipeline, {
        translationMaxRetries: 10,
        approvalScoreThreshold: 9.1,
        redraftScoreThreshold: 7.5,
        translationMaxRedrafts: 3,
    });
    prompts = getPrompts(config.translation.promptLang);
    signature = `${llmManager.provider}:${llmManager.getModelName()}`;
});

/**
 * A model that answers from a script: one function per kind of call, each
 * given the number of that call (1-based) and returning the answer's text.
 */
function scriptedModel(script) {
    const calls = [];
    const counts = { draft: 0, check: 0, fix: 0 };
    const kindOf = (system) => ['draft', 'check', 'fix']
        .find(kind => prompts[kind].system('русский') === system);
    const client = {
        async invoke(messages) {
            const kind = kindOf(messages[0].content);
            assert.ok(kind, 'a call the loop is not expected to make');
            counts[kind]++;
            calls.push(kind);
            return { content: await script[kind](counts[kind], messages[1].content) };
        },
    };
    llmManager.getClient = () => client;
    return calls;
}

function project(t, chunks) {
    const state = new ProjectState(tempWorkDir(t), 'book');
    state.data.metadata.targetLanguage = 'русский';
    state.setChunks(chunks.map(c => ({ original: 'Some text.', ...c })));
    return state;
}

const steps = (chunk) => chunk.history.map(h => h.step);

function refusal(flag) {
    const error = new Error(`refused: ${flag}`);
    error[flag] = true;
    return error;
}

beforeEach(() => { llmManager.getClient = () => { throw new Error('no model scripted'); }; });

test('a draft the reviewer accepts is saved as a success', async (t) => {
    const state = project(t, [{}]);
    const calls = scriptedModel({
        draft: () => answer('Перевод.', 'заметка'),
        check: () => verdict(),
    });

    await runTranslationLoopStage(state);

    const [chunk] = state.getChunks();
    assert.deepEqual(calls, ['draft', 'check']);
    assert.equal(chunk.translation, 'Перевод.');
    assert.equal(chunk.translation_status, 'success');
    assert.ok(chunk.translationTokens > 0);
    assert.deepEqual(steps(chunk), ['draft', 'check_1']);
    assert.equal(chunk.history[0].translator_comment, 'заметка');
});

test('a high score with like=1 is approved even with errors noted', async (t) => {
    const state = project(t, [{}]);
    scriptedModel({
        draft: () => answer('Перевод.'),
        check: () => verdict({ score: 9.5, error: 1 }),
    });

    await runTranslationLoopStage(state);
    assert.equal(state.getChunks()[0].translation_status, 'success');
});

test('a finished chunk is not touched again', async (t) => {
    const state = project(t, [{ translation: 'Готово.', translation_status: 'success' }]);
    const calls = scriptedModel({});

    await runTranslationLoopStage(state);
    assert.deepEqual(calls, []);
});

test('a decent draft is fixed rather than redrafted', async (t) => {
    const state = project(t, [{}]);
    let fixInput;
    const calls = scriptedModel({
        draft: () => answer('Черновик.'),
        check: (n) => n === 1 ? verdict({ score: 8, error: 1, comment: 'опечатка во второй фразе' }) : verdict(),
        fix: (n, input) => { fixInput = input; return answer('Исправлено.'); },
    });

    await runTranslationLoopStage(state);

    const [chunk] = state.getChunks();
    assert.deepEqual(calls, ['draft', 'check', 'fix', 'check']);
    assert.equal(chunk.translation, 'Исправлено.');
    assert.equal(chunk.translation_status, 'success');
    assert.deepEqual(steps(chunk), ['draft', 'check_1', 'fix_1', 'check_2']);
    assert.match(fixInput, /опечатка во второй фразе/);
    assert.match(fixInput, /Черновик\./);
});

test('a disliked draft is redrafted, and the same complaint twice is a dispute', async (t) => {
    const state = project(t, [{}]);
    const calls = scriptedModel({
        draft: (n) => answer(`Черновик ${n}.`),
        check: () => verdict({ score: 3, like: 0, error: 1, comment: 'обращение должно быть на ты' }),
    });

    await runTranslationLoopStage(state);

    const [chunk] = state.getChunks();
    assert.deepEqual(calls, ['draft', 'check', 'draft', 'check']);
    assert.equal(chunk.translation_status, 'failed_best_effort');
    assert.equal(chunk.dispute.kind, 'repeated_complaint');
    assert.equal(chunk.dispute.reason, 'обращение должно быть на ты');
    assert.deepEqual(steps(chunk), ['draft', 'check_1', 'redraft_1', 'check_2']);
});

test('redrafts stop at their cap when the complaints keep changing', async (t) => {
    const state = project(t, [{}]);
    const complaints = ['неверное время глаголов', 'потеряна шутка автора', 'имена записаны иначе', 'пропущено предложение'];
    const calls = scriptedModel({
        draft: (n) => answer(`Черновик ${n}.`),
        check: (n) => verdict({ score: n, like: 0, error: 1, comment: complaints[n - 1] }),
    });

    await runTranslationLoopStage(state);

    const [chunk] = state.getChunks();
    assert.equal(calls.filter(c => c === 'draft').length, 4);   // the draft and three redrafts
    assert.equal(chunk.dispute.kind, 'redraft_cap');
    assert.equal(chunk.translation_status, 'failed_best_effort');
    // Best effort is the highest-scored attempt, here the last one checked.
    assert.equal(chunk.translation, 'Черновик 4.');
});

test('when the retry budget runs out the best-scored attempt is kept', async (t) => {
    config.pipeline.translationMaxRetries = 3;
    t.after(() => { config.pipeline.translationMaxRetries = 10; });
    const state = project(t, [{}]);
    const scores = [8.5, 8.9, 8];
    const notes = ['опечатка в начале', 'лишняя запятая после союза', 'повтор слова рядом'];
    scriptedModel({
        draft: () => answer('Версия 1.'),
        check: (n) => verdict({ score: scores[n - 1], error: 1, comment: notes[n - 1] }),
        fix: (n) => answer(`Версия ${n + 1}.`),
    });

    await runTranslationLoopStage(state);

    const [chunk] = state.getChunks();
    assert.equal(chunk.translation, 'Версия 2.');
    assert.equal(chunk.translation_status, 'failed_best_effort');
    assert.equal(chunk.dispute, null);
    assert.deepEqual(steps(chunk), ['draft', 'check_1', 'fix_1', 'check_2', 'fix_2', 'check_3']);
});

test('advice on a finished chunk is acted on by a fix, never a redraft', async (t) => {
    const state = project(t, [{
        translation: 'Он ответил сухо.', translation_status: 'success',
        history: [{ step: 'draft', text: 'Он ответил сухо.' }, { step: 'check_1', text: 'Он ответил сухо.', result: { score: 10 } }],
        advice: [{ advice: 'заменить «сухо» на «коротко»', key: 'k1' }],
        dispute: { kind: 'repeated_complaint', reason: 'старый спор' },
    }]);
    let fixInput;
    const calls = scriptedModel({
        fix: (n, input) => { fixInput = input; return answer('Он ответил коротко.'); },
        check: () => verdict(),
    });

    await runTranslationLoopStage(state);

    const [chunk] = state.getChunks();
    assert.deepEqual(calls, ['fix', 'check']);
    assert.equal(chunk.translation, 'Он ответил коротко.');
    assert.equal(chunk.translation_status, 'success');
    assert.equal(chunk.advice, null);
    assert.equal(chunk.dispute, null);
    assert.match(fixInput, /заменить «сухо» на «коротко»/);
    const fix = chunk.history.find(h => h.step === 'advice_fix');
    assert.deepEqual(fix.keys, ['k1']);
});

test('under advice a low score still means a fix, and a repeated objection is a dispute', async (t) => {
    const state = project(t, [{
        translation: 'Старый текст.', translation_status: 'success',
        history: [{ step: 'check_1', text: 'Старый текст.', result: { score: 10 } }],
        advice: [{ advice: 'исправить обращение', key: 'k1' }],
    }]);
    const calls = scriptedModel({
        fix: (n) => answer(`Правка ${n}.`),
        check: (n) => verdict({ score: [5, 6][n - 1], like: 0, error: 1, comment: 'обращение осталось прежним' }),
    });

    await runTranslationLoopStage(state);

    const [chunk] = state.getChunks();
    assert.deepEqual(calls, ['fix', 'check', 'fix', 'check']);
    assert.equal(chunk.dispute.kind, 'advice_not_met');
    assert.equal(chunk.translation_status, 'failed_best_effort');
    // The score of 10 predates the advice and must not bring the old text back.
    assert.equal(chunk.translation, 'Правка 2.');
    // Not approved, so the advice still stands.
    assert.equal(chunk.advice.length, 1);
});

test('a chunk the content filter refuses is skipped and the run goes on', async (t) => {
    const state = project(t, [{ original: 'Rough scene.' }, { original: 'Calm scene.' }]);
    scriptedModel({
        draft: (n, input) => {
            if (/Rough scene/.test(input)) throw refusal('contentBlocked');
            return answer('Тихая сцена.');
        },
        check: () => verdict(),
    });

    await runTranslationLoopStage(state);

    const [rough, calm] = state.getChunks();
    assert.equal(rough.translation_status, 'blocked');
    assert.equal(rough.translation_blocked_by, signature);
    assert.equal(rough.translation, undefined);
    assert.equal(calm.translation_status, 'success');
});

test('the model that refused a chunk skips it; a refusal recorded for another model is retried', async (t) => {
    const state = project(t, [
        { translation_status: 'blocked', translation_blocked_by: signature },
        { translation_status: 'blocked', translation_blocked_by: 'google:some-other-model' },
    ]);
    const calls = scriptedModel({ draft: () => answer('Перевод.'), check: () => verdict() });

    await runTranslationLoopStage(state);

    const [mine, theirs] = state.getChunks();
    assert.deepEqual(calls, ['draft', 'check']);
    assert.equal(mine.translation_status, 'blocked');
    assert.equal(theirs.translation_status, 'success');
    assert.equal(theirs.translation_blocked_by, null);
});

test('a refusal to rework an approved chunk leaves its translation and history alone', async (t) => {
    const history = [{ step: 'draft', text: 'Принято.' }];
    const state = project(t, [{
        translation: 'Принято.', translation_status: 'success', history,
        advice: [{ advice: 'поправить', key: 'k1' }],
    }]);
    scriptedModel({ fix: () => { throw refusal('contentBlocked'); } });

    await runTranslationLoopStage(state);

    const [chunk] = state.getChunks();
    assert.equal(chunk.translation, 'Принято.');
    assert.equal(chunk.translation_status, 'success');
    assert.equal(chunk.translation_blocked_by, signature);
    assert.deepEqual(chunk.history, history);
    assert.equal(chunk.advice.length, 1);
});

test('an answer lost to runaway reasoning is asked for once more', async (t) => {
    const state = project(t, [{}]);
    const calls = scriptedModel({
        draft: (n) => { if (n === 1) throw refusal('outputExhausted'); return answer('Перевод.'); },
        check: () => verdict(),
    });

    await runTranslationLoopStage(state);
    assert.deepEqual(calls, ['draft', 'draft', 'check']);
    assert.equal(state.getChunks()[0].translation_status, 'success');
});

test('no answer twice leaves the chunk for the next run; three such chunks in a row stop it', async (t) => {
    const state = project(t, [{}, {}, {}, {}]);
    scriptedModel({ draft: () => { throw refusal('outputExhausted'); } });

    await assert.rejects(runTranslationLoopStage(state), /3 chunks in a row got no answer \(1, 2, 3\)/);

    for (const chunk of state.getChunks()) {
        assert.equal(chunk.translation, undefined);
        assert.equal(chunk.translation_blocked_by, undefined);
    }
});

test('any other failure ends the run', async (t) => {
    const state = project(t, [{}]);
    scriptedModel({ draft: () => { throw new Error('bad API key'); } });

    await assert.rejects(runTranslationLoopStage(state), /bad API key/);
});

test('an answer without the <translate> tag is asked for again, not pasted into the book', async (t) => {
    const state = project(t, [{}]);
    const calls = scriptedModel({
        draft: (n) => n < 3 ? 'Sure, here is my reasoning about the text...' : answer('Перевод.'),
        check: () => verdict(),
    });

    await runTranslationLoopStage(state);
    assert.deepEqual(calls, ['draft', 'draft', 'draft', 'check']);
    assert.equal(state.getChunks()[0].translation, 'Перевод.');
});

test('the cheat sheet in the prompt carries only the glossary entries the chunk mentions', async (t) => {
    const state = project(t, [{ original: 'Elaine noticed the Scavenger.' }]);
    const fs = await import('fs');
    fs.mkdirSync(state.projectDir, { recursive: true });
    fs.writeFileSync(state.getGlossaryPath(), JSON.stringify([
        { original: 'Elaine', translation: 'Элейн', type: 'name', gender: 'f', notes: 'главная героиня' },
        { original: 'Scavenger', translation: 'Падальщик', type: 'term' },
        { original: 'ICE', translation: 'ЛЁД', type: 'term' },
    ]));
    let draftInput;
    scriptedModel({ draft: (n, input) => { draftInput = input; return answer('Перевод.'); }, check: () => verdict() });

    await runTranslationLoopStage(state);

    assert.match(draftInput, /Elaine -> Элейн \(жен\) — главная героиня/);
    assert.match(draftInput, /Scavenger -> Падальщик/);
    assert.doesNotMatch(draftInput, /ЛЁД/);   // "ICE" is not in "noticed"
});
