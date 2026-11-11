import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cheatSheet, contradictedNames } from '../src_v4/core/cheat_sheet.js';
import { linkTarget, resolveLinks, fullerForm, MAX_NOTE_CHARS } from '../src_v4/core/glossary_links.js';
import { wholeWordRegex, nameRegex, entryRegex, countOccurrences } from '../src_v4/core/text_stats.js';

const name = (original, translation, extra = {}) => ({ original, translation, type: 'name', ...extra });
const term = (original, translation, extra = {}) => ({ original, translation, type: 'term', ...extra });

// --- finding an entry in text ---

test('a term is matched as a whole word, in any case', () => {
    assert.equal(countOccurrences('We noticed the ICE. Ice again; ice-cold.', term('ICE', 'ЛЁД')), 3);
    assert.equal(entryRegex(term('M', 'М')).test('a memory of Mars'), false);
});

test('a term wrapped across a line break is still found', () => {
    assert.equal(wholeWordRegex('Modelview Matrix').test('the Modelview\nMatrix was wrong'), true);
});

test('a name is matched with its case, so the word it is spelled like does not fire', () => {
    const face = nameRegex('Face');
    assert.equal('Her face fell. Then Face spoke, and FACE answered.'.match(face).length, 2);
});

test('a name with an article matches the article in either case', () => {
    const re = nameRegex('The Advocate');
    assert.equal('The Advocate and the Advocate, but not the advocate.'.match(re).length, 2);
});

test('text without spaces between words is matched as a substring', () => {
    assert.equal(entryRegex(name('太郎', 'Таро')).test('今日は太郎が来た'), true);
});

// --- links between forms of one name ---

test('linkTarget reads "= Name" and nothing else as a link', () => {
    assert.equal(linkTarget('= Maria Johnson'), 'Maria Johnson');
    assert.equal(linkTarget('  =Maria  '), 'Maria');
    assert.equal(linkTarget('sister of Maria'), null);
    assert.equal(linkTarget(''), null);
});

test('resolveLinks points a clone at its prime, by original or by translation', () => {
    const glossary = [
        name('Maria Johnson', 'Мария Джонсон'),
        name('Johnson', 'Джонсон', { notes: '= Maria Johnson' }),
        name('Masha', 'Маша', { notes: '= Мария Джонсон' }),
    ];
    assert.deepEqual(resolveLinks(glossary), { prime: [null, 0, 0], broken: [] });
});

test('resolveLinks reports every kind of link that leads nowhere', () => {
    const glossary = [
        name('A', 'А', { notes: '= Nobody' }),            // missing
        name('B', 'Б', { notes: '= B' }),                 // self
        name('Smith', 'Смит'), name('Smith', 'Смит'),
        name('C', 'В', { notes: '= Smith' }),             // ambiguous
        name('D', 'Г', { notes: '= C' }),                 // chain
        term('gizmo', 'штуковина', { notes: '= Smith' }), // not a name
    ];
    const { prime, broken } = resolveLinks(glossary);
    assert.deepEqual(prime, glossary.map(() => null));
    assert.deepEqual(broken.map(b => [b.index, b.reason]),
        [[0, 'missing'], [1, 'self'], [4, 'ambiguous'], [5, 'chain'], [6, 'notName']]);
});

test('fullerForm says which of two forms of a name is the full one', () => {
    assert.equal(fullerForm('Johnson', 'Maria Johnson'), 'b');
    assert.equal(fullerForm('Maria Johnson', 'Maria'), 'a');
    assert.equal(fullerForm('Ms Johnson', 'Johnson'), 'either');
    assert.equal(fullerForm('Maria', 'Elaine'), null);
});

// --- the cheat sheet ---

test('contradictedNames flags a bare name whose gender a fuller form disputes', () => {
    const glossary = [
        name('Smith', 'Смит', { gender: 'm' }),
        name('Sue Smith', 'Сью Смит', { gender: 'f' }),
        name('Kay', 'Кей', { gender: 'f' }),
        name('Kay Coolidge', 'Кей Кулидж', { gender: 'f' }),
    ];
    assert.deepEqual([...contradictedNames(glossary)], ['smith']);
});

test('contradictedNames ignores a clone: its own gender is never sent', () => {
    const glossary = [
        name('Sue Smith', 'Сью Смит', { gender: 'f' }),
        name('Smith', 'Смит', { gender: 'm', notes: '= Sue Smith' }),
    ];
    const { prime } = resolveLinks(glossary);
    assert.equal(contradictedNames(glossary, prime).size, 0);
});

test('the cheat sheet lists only what the chunk mentions, with gender and note for people', () => {
    const glossary = [
        name('Elaine', 'Элейн', { gender: 'f', notes: 'главная героиня' }),
        term('Scavenger', 'Падальщик', { gender: 'm' }),
        term('ICE', 'ЛЁД'),
    ];
    assert.equal(cheatSheet('Elaine noticed the Scavenger.', glossary),
        'Elaine -> Элейн (жен) — главная героиня\nScavenger -> Падальщик');
    assert.equal(cheatSheet('Nothing of note.', glossary), '');
});

test('forms of one person share a line that speaks with the prime\'s gender and note', () => {
    const glossary = [
        name('Maria Johnson', 'Мария Джонсон', { gender: 'f', notes: 'детектив' }),
        name('Johnson', 'Джонсон', { gender: 'm', notes: '= Maria Johnson' }),
    ];
    const { prime } = resolveLinks(glossary);

    assert.equal(cheatSheet('Maria Johnson came in.', glossary, new Set(), prime),
        'Maria Johnson / Johnson -> Мария Джонсон / Джонсон (жен) — детектив');
    // A chunk that says only the surname still learns who she is.
    assert.equal(cheatSheet('Johnson came in.', glossary, new Set(), prime),
        'Johnson -> Джонсон (жен) — детектив');
});

test('a contradicted name travels without a gender, and a long note is cut', () => {
    const glossary = [
        name('Smith', 'Смит', { gender: 'm', notes: 'x'.repeat(MAX_NOTE_CHARS + 30) }),
        name('Sue Smith', 'Сью Смит', { gender: 'f' }),
    ];
    const line = cheatSheet('Smith left.', glossary, contradictedNames(glossary));
    assert.equal(line, `Smith -> Смит — ${'x'.repeat(MAX_NOTE_CHARS)}…`);
});

test('a link that resolved to nothing is not sent as a note', () => {
    const glossary = [name('Johnson', 'Джонсон', { gender: 'f', notes: '= Nobody' })];
    assert.equal(cheatSheet('Johnson came in.', glossary, new Set(), resolveLinks(glossary).prime),
        'Johnson -> Джонсон (жен)');
});
