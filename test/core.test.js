/** The small deterministic pieces: diff, state, atomic writes, note boundaries, advice. */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { wordDiff, condense, diffSize } from '../src_v4/core/text_diff.js';
import { ProjectState, withoutTranslation, TRANSLATION_FIELDS } from '../src_v4/core/state_manager.js';
import { renameWithRetry, writeFileAtomic } from '../src_v4/utils/atomic_write.js';
import { placeNotes, notesForChunk } from '../src_v4/core/note_bounds.js';
import { adviceForChunk, adviceQueue } from '../src_v4/core/translation_review.js';
import { parseChunkList, chunksContaining } from '../src_v4/core/manual_advice.js';
import { locateQuote } from '../src_v4/core/quoted_spans.js';
import { exportFileName, projectPaths } from '../src_v4/core/paths.js';
import { tempWorkDir, silenceConsole } from './helpers.js';

before(() => { silenceConsole(); });

// --- text_diff ---

const rebuild = (runs, drop) => runs.filter(r => r.op !== drop).map(r => r.text).join('');

test('wordDiff reports a replaced word and reassembles into both texts exactly', () => {
    const before = 'Он ответил сухо,\nи вышел.';
    const after = 'Он ответил коротко,\nи вышел.';
    const runs = wordDiff(before, after);

    assert.deepEqual(runs, [
        { op: 'same', text: 'Он ответил ' },
        { op: 'del', text: 'сухо,' },
        { op: 'ins', text: 'коротко,' },
        { op: 'same', text: '\nи вышел.' },
    ]);
    assert.equal(rebuild(runs, 'ins'), before);
    assert.equal(rebuild(runs, 'del'), after);
});

test('wordDiff handles identical, empty and wholly different texts', () => {
    assert.deepEqual(wordDiff('same text', 'same text'), [{ op: 'same', text: 'same text' }]);
    assert.deepEqual(wordDiff('', 'new'), [{ op: 'ins', text: 'new' }]);
    assert.deepEqual(wordDiff('old', ''), [{ op: 'del', text: 'old' }]);
    assert.deepEqual(wordDiff('', ''), []);
});

test('wordDiff round-trips a change in the middle of repeated words', () => {
    const before = 'a b a b a b c a b';
    const after = 'a b a x a b c c a b';
    const runs = wordDiff(before, after);
    assert.equal(rebuild(runs, 'ins'), before);
    assert.equal(rebuild(runs, 'del'), after);
});

test('condense cuts long unchanged stretches down to their ends and says how much went', () => {
    const long = 'x'.repeat(500);
    const runs = [{ op: 'same', text: long }, { op: 'del', text: 'a' }, { op: 'ins', text: 'b' }, { op: 'same', text: long }];
    assert.deepEqual(condense(runs, 90), [
        { op: 'gap', chars: 410 },
        { op: 'same', text: 'x'.repeat(90) },
        { op: 'del', text: 'a' },
        { op: 'ins', text: 'b' },
        { op: 'same', text: 'x'.repeat(90) },
        { op: 'gap', chars: 410 },
    ]);
    // A short stretch is worth more whole than cut.
    const short = [{ op: 'del', text: 'a' }, { op: 'same', text: 'x'.repeat(200) }, { op: 'ins', text: 'b' }];
    assert.deepEqual(condense(short, 90), short);
});

test('diffSize counts characters added and removed', () => {
    assert.deepEqual(diffSize(wordDiff('one two', 'one three')), { added: 5, removed: 3 });
});

// --- state ---

test('withoutTranslation removes the translation\'s fields and nothing else', () => {
    const chunk = {
        original: 'text', tokens: 12, extracted_terms: [], extraction_status: 'success', blocked_by: 'm',
        somethingAddedLater: 1,
        ...Object.fromEntries(TRANSLATION_FIELDS.map(f => [f, 'x'])),
    };
    assert.deepEqual(withoutTranslation(chunk), {
        original: 'text', tokens: 12, extracted_terms: [], extraction_status: 'success', blocked_by: 'm',
        somethingAddedLater: 1,
    });
    assert.equal(chunk.translation, 'x');   // a copy: the chunk itself is untouched
});

test('a project state survives a save and a load', (t) => {
    const dir = tempWorkDir(t);
    const state = new ProjectState(dir, 'book');
    state.setChunks([{ original: 'one' }, { original: 'two' }]);
    state.updateChunk(1, { translation: 'два' });
    state.save();

    const loaded = new ProjectState(dir, 'book');
    loaded.load();
    assert.deepEqual(loaded.getChunks(), [{ original: 'one' }, { original: 'two', translation: 'два' }]);
    assert.equal(loaded.stateFile, projectPaths(dir, 'book').state);
    assert.equal(fs.existsSync(`${loaded.stateFile}.tmp`), false);
    assert.throws(() => loaded.updateChunk(5, {}), /out of bounds/);
});

// --- atomic_write ---

test('writeFileAtomic replaces a file whole', (t) => {
    const file = path.join(tempWorkDir(t), 'data.json');
    writeFileAtomic(file, 'first');
    writeFileAtomic(file, 'second');
    assert.equal(fs.readFileSync(file, 'utf-8'), 'second');
    assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('renameWithRetry waits out a busy destination', () => {
    let calls = 0;
    const slept = [];
    renameWithRetry('a.tmp', 'a', {
        rename: () => { if (++calls < 3) throw Object.assign(new Error('busy'), { code: 'EPERM' }); },
        sleep: (ms) => slept.push(ms),
    });
    assert.equal(calls, 3);
    assert.deepEqual(slept, [10, 20]);
});

test('renameWithRetry gives up with a message that says where the content went', () => {
    const io = { rename: () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); }, sleep: () => {} };
    assert.throws(() => renameWithRetry('/x/state.json.tmp', '/x/state.json', io), (err) => {
        assert.equal(err.code, 'EBUSY');
        assert.match(err.message, /Could not replace \/x\/state\.json/);
        assert.match(err.message, /state\.json\.tmp/);
        return true;
    });
});

test('renameWithRetry does not retry an error that waiting cannot cure', () => {
    let calls = 0;
    const io = { rename: () => { calls++; throw Object.assign(new Error('gone'), { code: 'ENOENT' }); }, sleep: () => {} };
    assert.throws(() => renameWithRetry('a.tmp', 'a', io), /gone/);
    assert.equal(calls, 1);
});

// --- note boundaries ---

test('a bounded note reaches only the chunks between its places, and the chunk a place cuts is told where', () => {
    const chunks = [
        { original: 'Socrates said he was glad. ' },
        { original: 'More of the same. From here on call me Crystal. She smiled. ' },
        { original: 'Crystal walked on. ' },
    ];
    const place = 'From here on call me Crystal.';
    const notes = placeNotes([
        { advice: 'masculine', until: place },
        { advice: 'feminine', from: place },
        { advice: 'everywhere' },
        { advice: 'lost boundary', from: 'nothing like this is in the text' },
    ], chunks);
    const given = i => notesForChunk(notes, i).map(x => [x.note.advice, x.from || x.until ? 'cut' : '']);
    assert.deepEqual(given(0), [['masculine', ''], ['everywhere', ''], ['lost boundary', '']]);
    assert.deepEqual(given(1), [['masculine', 'cut'], ['feminine', 'cut'], ['everywhere', ''], ['lost boundary', '']]);
    assert.deepEqual(given(2), [['feminine', ''], ['everywhere', ''], ['lost boundary', '']]);
});

test('a place that opens a chunk leaves that chunk wholly on its own side', () => {
    const chunks = [{ original: 'Before the change, all of it. ' }, { original: 'The change begins right here. After.' }];
    const notes = placeNotes([{ advice: 'a', until: 'The change begins right here.' }, { advice: 'b', from: 'The change begins right here.' }], chunks);
    assert.deepEqual(notes.map(n => [n.place.first, n.place.last]), [[0, 0], [1, 1]]);
    assert.deepEqual(notesForChunk(notes, 1).map(x => [x.note.advice, x.from]), [['b', null]]);
});

// --- advice ---// --- advice ---

test('adviceForChunk gives one instruction as it is and numbers several', () => {
    assert.equal(adviceForChunk(undefined), '');
    assert.equal(adviceForChunk([{ advice: '  поправить имя ' }]), 'поправить имя');
    assert.equal(adviceForChunk([{ advice: 'первое' }, { advice: '' }, { advice: 'второе' }]), '1. первое\n2. второе');
});

test('adviceQueue lists the chunks with work outstanding', () => {
    const chunks = [{}, { advice: [{ advice: 'a' }] }, { advice: [] }, { advice: null }];
    assert.deepEqual(adviceQueue(chunks), [{ chunk: 1, items: [{ advice: 'a' }] }]);
});

test('parseChunkList reads numbers and ranges as a person types them', () => {
    assert.deepEqual(parseChunkList('3, 7-9; 40 3', 50), { indices: [2, 6, 7, 8, 39], bad: [] });
    assert.deepEqual(parseChunkList('9-7', 50).indices, [6, 7, 8]);
    assert.deepEqual(parseChunkList('0, 51, x, 2', 50), { indices: [1], bad: ['0', '51', 'x'] });
});

test('chunksContaining finds a phrase across a line break, case aside', () => {
    const chunks = [{ translation: 'Он вошёл\nв комнату.' }, { translation: 'Пусто.' }, {}];
    assert.deepEqual(chunksContaining(chunks, 'ВОШЁЛ в комнату'), [0]);
    assert.deepEqual(chunksContaining(chunks, '   '), []);
});

// --- quotes and paths ---

test('locateQuote finds a quote across a hard wrap and says where it really ends', () => {
    const text = 'Intro line.\nShe walked into\nthe quiet room and stopped.';
    const quote = 'walked into the quiet room';
    const found = locateQuote(text, quote);
    assert.equal(found.occurrences, 1);
    assert.equal(text.slice(found.offset, found.end), 'walked into\nthe quiet room');
});

test('locateQuote refuses a quote too short to be unique and flags a repeated one', () => {
    assert.deepEqual(locateQuote('some text here', 'text'), { offset: -1, end: -1, occurrences: 0 });
    assert.equal(locateQuote('the same phrase, the same phrase', 'the same phrase').occurrences, 2);
    assert.equal(locateQuote('some text here', 'not in the text').offset, -1);
});

test('exportFileName carries the language suffix', () => {
    assert.equal(exportFileName('Book', { suffix: 'rus' }), 'Book_rus.txt');
    assert.equal(exportFileName('Book', { suffix: 'rus' }, 'fb2'), 'Book_rus.fb2');
});
