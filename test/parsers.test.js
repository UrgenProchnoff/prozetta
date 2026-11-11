import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
    extractJson, describeJsonError, extractCheckResult, extractFromTags, extractTagOptional,
} from '../src_v4/utils/parsers.js';
import { silenceConsole } from './helpers.js';

before(() => { silenceConsole(); });

// --- extractJson ---

test('extractJson reads a fenced block and ignores the prose around it', () => {
    const text = 'Here you go:\n```json\n{"a": 1}\n```\nHope it helps.';
    assert.deepEqual(extractJson(text), { a: 1 });
});

test('extractJson reads bare JSON surrounded by prose', () => {
    assert.deepEqual(extractJson('Answer: {"a": [1, 2]} — done.'), { a: [1, 2] });
    assert.deepEqual(extractJson('Answer: [{"a": 1}] — done.'), [{ a: 1 }]);
});

test('extractJson keeps the object that wraps an array', () => {
    // Array-before-object once returned the findings alone and lost the score.
    const text = '{"score": 7, "summary": "ok", "findings": [{"quote": "x"}]}';
    assert.deepEqual(extractJson(text), { score: 7, summary: 'ok', findings: [{ quote: 'x' }] });
});

test('extractJson repairs unescaped quotes inside a comment', () => {
    const text = '{"score": 8, "comment": "the word "cold" is wrong"}';
    assert.deepEqual(extractJson(text), { score: 8, comment: "the word 'cold' is wrong" });
});

test('extractJson throws when there is nothing to parse, and says where a block broke', () => {
    assert.throws(() => extractJson('no structure here'), /No JSON found/);

    const text = 'Reply:\n{"a": 1,, "b": 2}';
    assert.throws(() => extractJson(text), (err) => {
        assert.match(err.message, /^Invalid JSON/);
        assert.equal(err.source, '{"a": 1,, "b": 2}');
        assert.equal(err.offset, text.indexOf('{'));
        return true;
    });
});

// --- describeJsonError ---

test('describeJsonError points at the unnamed string, not at the comma after it', () => {
    const text = [
        'Here is the review:',
        '{',
        '  "summary": "Reads well overall.",',
        '  "The main problems are below.",',
        '  "score": 7',
        '}',
    ].join('\n');
    let error;
    try { extractJson(text); } catch (e) { error = e; }

    const where = describeJsonError(text, error);
    assert.equal(where.kind, 'broken');
    assert.equal(where.hint, 'bare_string');
    assert.equal(where.line, 4);
    assert.equal(where.column, 3);
    assert.equal(where.excerpt, '"The main problems are below.",');
});

test('describeJsonError has nothing to say about an error that carries no source', () => {
    assert.deepEqual(describeJsonError('text', new Error('No JSON found in response')), { kind: 'none' });
});

// --- extractCheckResult ---

test('extractCheckResult reads a well-formed verdict', () => {
    const text = '```json\n{"error": 0, "misspell": 0, "correctness": 1, "like": 1, "score": 9.5, "comment": "fine"}\n```';
    assert.deepEqual(extractCheckResult(text),
        { error: 0, misspell: 0, correctness: 1, like: 1, score: 9.5, comment: 'fine' });
});

test('extractCheckResult turns numeric strings and booleans into numbers', () => {
    // The loop compares strictly (like === 1), so "1" or true must not read as a refusal.
    const result = extractCheckResult('{"error": "0", "misspell": false, "correctness": true, "like": "1", "score": "9.2", "comment": "ok"}');
    assert.deepEqual(result, { error: 0, misspell: 0, correctness: 1, like: 1, score: 9.2, comment: 'ok' });
});

test('extractCheckResult falls back to defaults for missing or meaningless fields', () => {
    const result = extractCheckResult('{"like": "yes", "score": 8}');
    assert.deepEqual(result, { error: 1, misspell: 0, correctness: 0, like: 0, score: 8, comment: 'Parse error' });
});

test('extractCheckResult salvages the fields of a broken answer and never throws', () => {
    const broken = extractCheckResult('{"error": 0, "like": 1, "score": 9.5, "comment": "cut off mid-sent');
    assert.equal(broken.error, 0);
    assert.equal(broken.like, 1);
    assert.equal(broken.score, 9.5);
    assert.match(broken.comment, /^Fallback regex parse/);

    const nothing = extractCheckResult('I could not evaluate this.');
    assert.equal(nothing.error, 1);
    assert.equal(nothing.like, 0);
    assert.equal(nothing.score, 0);
});

// --- tags ---

test('extractFromTags returns the tag content, closed or cut off', () => {
    assert.equal(extractFromTags('<translate>\n Текст. \n</translate><comment>c</comment>', 'translate'), 'Текст.');
    assert.equal(extractFromTags('thinking... <translate>Текст, обрыв', 'translate'), 'Текст, обрыв');
    assert.equal(extractFromTags('<TRANSLATE>Текст</TRANSLATE>', 'translate'), 'Текст');
});

test('extractFromTags returns null without the tag, so reasoning is never taken for a translation', () => {
    assert.equal(extractFromTags('Sure! Let me think about this text.', 'translate'), null);
});

test('extractTagOptional returns an empty string for a missing or unclosed tag', () => {
    assert.equal(extractTagOptional('<comment> note </comment>', 'comment'), 'note');
    assert.equal(extractTagOptional('<translate>x</translate>', 'comment'), '');
    assert.equal(extractTagOptional('<comment>never closed', 'comment'), '');
});
