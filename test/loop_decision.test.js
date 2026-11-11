import { test } from 'node:test';
import assert from 'node:assert/strict';
import { complaintsAlike, isApproved, nextStep, bestAttempt } from '../src_v4/core/loop_decision.js';

const limits = { maxRetries: 10, maxRedrafts: 3, approvalThreshold: 9.1, redraftThreshold: 7.5 };
const check = (over = {}) => ({ error: 1, misspell: 0, correctness: 1, like: 1, score: 8, comment: 'опечатка', ...over });
const decide = (over = {}) => nextStep({
    check: check(), attempts: 1, underAdvice: false, redrafts: 0,
    lastFixComplaint: null, lastRedraftComplaint: null, limits, ...over,
});

// --- complaintsAlike ---

test('complaintsAlike sees through rewording of the same complaint', () => {
    assert.equal(complaintsAlike('Переводчик использовал обращение на вы', 'Используется обращение на Вы вместо ты'), true);
});

test('complaintsAlike tells different complaints apart', () => {
    assert.equal(complaintsAlike('неверное время глаголов', 'потеряна шутка автора'), false);
});

test('complaintsAlike is false when either side has no words to compare', () => {
    assert.equal(complaintsAlike('', 'обращение на вы'), false);
    assert.equal(complaintsAlike('ок', 'ок'), false);          // nothing of four letters
    assert.equal(complaintsAlike(null, undefined), false);
});

// --- isApproved ---

test('a clean sheet is approved whatever the score', () => {
    assert.equal(isApproved({ error: 0, misspell: 0, correctness: 1, like: 1, score: 5 }, 9.1), true);
});

test('a liked text is approved at the threshold, not below it', () => {
    assert.equal(isApproved(check({ score: 9.1 }), 9.1), true);
    assert.equal(isApproved(check({ score: 9.0 }), 9.1), false);
});

test('a high score does not approve a text the reviewer does not like', () => {
    assert.equal(isApproved(check({ like: 0, score: 10 }), 9.1), false);
});

// --- nextStep ---

test('an approval wins over everything else', () => {
    assert.deepEqual(decide({ check: check({ score: 9.5 }), attempts: 10 }), { action: 'approve' });
});

test('with the retry budget spent the loop stops instead of buying a repair nobody will check', () => {
    assert.deepEqual(decide({ attempts: 10 }), { action: 'stop' });
    assert.deepEqual(decide({ attempts: 9 }), { action: 'fix' });
});

test('a liked text at or above the redraft threshold is fixed; below it, or disliked, redrafted', () => {
    assert.deepEqual(decide({ check: check({ score: 7.5 }) }), { action: 'fix' });
    assert.deepEqual(decide({ check: check({ score: 7.4 }) }), { action: 'redraft' });
    assert.deepEqual(decide({ check: check({ like: 0, score: 9 }) }), { action: 'redraft' });
});

test('a repeated fix complaint is not a dispute without advice — errors can take several passes', () => {
    assert.deepEqual(decide({ lastFixComplaint: 'опечатка' }), { action: 'fix' });
});

test('under advice the repair is always a fix, however low the score', () => {
    assert.deepEqual(decide({ underAdvice: true, check: check({ like: 0, score: 2 }), redrafts: 3 }), { action: 'fix' });
});

test('under advice the same objection after a fix is a dispute', () => {
    assert.deepEqual(decide({ underAdvice: true, lastFixComplaint: 'опечатка осталась' }),
        { action: 'dispute', kind: 'advice_not_met' });
    assert.deepEqual(decide({ underAdvice: true, lastFixComplaint: 'потеряна шутка автора' }), { action: 'fix' });
});

test('the same complaint about a fresh draft is a dispute', () => {
    const bad = check({ like: 0, score: 3, comment: 'обращение должно быть на ты' });
    assert.deepEqual(decide({ check: bad, redrafts: 1, lastRedraftComplaint: 'обращение должно быть на ты, а не на вы' }),
        { action: 'dispute', kind: 'repeated_complaint' });
});

test('redrafts are capped separately from the retry budget', () => {
    const bad = check({ like: 0, score: 3 });
    assert.deepEqual(decide({ check: bad, redrafts: 2, lastRedraftComplaint: 'потеряна шутка автора' }), { action: 'redraft' });
    assert.deepEqual(decide({ check: bad, redrafts: 3, lastRedraftComplaint: 'потеряна шутка автора' }),
        { action: 'dispute', kind: 'redraft_cap' });
});

// --- bestAttempt ---

test('bestAttempt keeps the highest-scored text, the earlier one on a tie', () => {
    const history = [
        { step: 'draft', text: 'A' },
        { step: 'check_1', text: 'A', result: { score: 8 } },
        { step: 'fix_1', text: 'B' },
        { step: 'check_2', text: 'B', result: { score: 9 } },
        { step: 'fix_2', text: 'C' },
        { step: 'check_3', text: 'C', result: { score: 9 } },
    ];
    assert.deepEqual(bestAttempt(history, false, 'C'), { text: 'B', score: 9 });
});

test('bestAttempt falls back to the current text when nothing was scored', () => {
    assert.deepEqual(bestAttempt([{ step: 'draft', text: 'A' }], false, 'A'), { text: 'A', score: -1 });
    assert.deepEqual(bestAttempt([], false, ''), { text: '', score: -1 });
});

test('under advice, scores from before the last advice fix do not count', () => {
    const history = [
        { step: 'check_1', text: 'old', result: { score: 10 } },
        { step: 'advice_fix', text: 'first round' },
        { step: 'check_1', text: 'first round', result: { score: 9.8 } },
        { step: 'advice_fix', text: 'second round' },
        { step: 'check_1', text: 'second round', result: { score: 7 } },
    ];
    assert.deepEqual(bestAttempt(history, true, 'second round'), { text: 'second round', score: 7 });
    // Without advice in play the whole history is fair game.
    assert.deepEqual(bestAttempt(history, false, 'second round'), { text: 'old', score: 10 });
});
