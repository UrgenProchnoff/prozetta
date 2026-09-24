/**
 * Glossary hygiene — deterministic clean-up, no LLM involved.
 *
 * Extraction builds the glossary chunk by chunk, so the same character ends up
 * under several entries ("Sue Smith", "Smith", "Detective Sergeant Smith"),
 * sometimes with contradictory genders, and the surface form that actually
 * occurs in the book ("Sue") can be missing entirely. Entries whose text never
 * appears, junk one- and two-letter items and untranslated leftovers pile up
 * the same way.
 *
 * This tool measures all of that against the source text and reports it. With
 * --apply it also performs the fixes that cannot be wrong: merging entries that
 * differ only by case, filling in a missing gender from pronoun co-occurrence,
 * and dropping entries that never occur. Everything else — merging nested
 * names, deleting suspicious items — is left as a report, because those calls
 * need a human.
 *
 * Usage:
 *   node src_v4/tools/glossary_hygiene.js --file=txt/Book.txt          # report
 *   node src_v4/tools/glossary_hygiene.js --file=txt/Book.txt --apply  # + fix
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ProjectState } from '../core/state_manager.js';
import { writeFileAtomic } from '../utils/atomic_write.js';
import { countOccurrences, genderFromPronouns } from '../core/text_stats.js';
import { resolveLinks, linkTarget } from '../core/glossary_links.js';

function normalizeGender(g) {
    const s = String(g || '').trim().toLowerCase();
    if (['m', 'male', 'м', 'муж'].includes(s)) return 'm';
    if (['f', 'female', 'ж', 'жен'].includes(s)) return 'f';
    if (['n', 'neuter', 'с'].includes(s)) return 'n';
    return null;
}

/** Prefer the surface form the book actually uses over a SHOUTED heading form. */
function betterSurfaceForm(a, b) {
    const shouted = s => s.length > 1 && s === s.toUpperCase() && /\p{L}/u.test(s);
    if (shouted(a) && !shouted(b)) return b;
    if (shouted(b) && !shouted(a)) return a;
    return a;
}

export function analyzeGlossary(glossary, sourceText) {
    const entries = glossary.map((term, index) => {
        const original = String(term.original || '').trim();
        return {
            index,
            term,
            original,
            count: original ? countOccurrences(sourceText, { original, type: term.type }) : 0,
            gender: normalizeGender(term.gender),
        };
    });

    // --- prime and clone links: "Johnson" noted "= Maria Johnson" ---
    const links = resolveLinks(glossary);
    const isClone = e => links.prime[e.index] != null;

    // --- entries differing only by case: "ELAINE" vs "Elaine" ---
    const byLower = new Map();
    for (const e of entries) {
        if (!e.original) continue;
        const key = e.original.toLowerCase();
        if (!byLower.has(key)) byLower.set(key, []);
        byLower.get(key).push(e);
    }
    const caseDuplicates = [...byLower.values()].filter(group => group.length > 1);

    // --- nested names: "Sue Smith" contains "Smith" ---
    const singles = new Map();
    for (const e of entries) {
        if (e.original && !/\s/.test(e.original)) singles.set(e.original.toLowerCase(), e);
    }
    const nested = [];
    for (const e of entries) {
        if (!e.original || !/\s/.test(e.original)) continue;
        for (const part of e.original.split(/\s+/)) {
            const inner = singles.get(part.toLowerCase());
            if (inner && part.length > 2) {
                nested.push({ outer: e, inner, bothNames: e.term.type === 'name' && inner.term.type === 'name' });
            }
        }
    }

    // --- one name, two transliterations ---
    // Nesting itself is normal and necessary: a book uses both "Roger Coolidge"
    // and "Coolidge", and the cheat sheet must fire on both. What is a defect is
    // the shared part being rendered differently in the two entries — one person
    // with two spellings, which is exactly what a glossary exists to prevent.
    // Measured across three books: 77 of 80 nested name pairs agree, 5 do not
    // («Перки Пат» against «Пэт», «Ву Чэнь» against «Чен»).
    const inconsistentNested = [];
    for (const { outer, inner, bothNames } of nested) {
        if (!bothNames) continue;
        // A linked pair is checked more strictly below.
        if (links.prime[inner.index] === outer.index || links.prime[outer.index] === inner.index) continue;
        const o = String(outer.term.translation || '').toLowerCase();
        const i = String(inner.term.translation || '').toLowerCase();
        if (!o || !i) continue;
        // Tolerate inflection: compare on the stem, since a compound may decline
        // its parts differently from the bare name.
        const stem = i.length > 4 ? i.slice(0, -2) : i;
        if (!o.includes(stem)) inconsistentNested.push({ outer, inner });
    }

    // --- one person, contradictory genders ---
    // Names only. For a term, `gender` is the grammatical gender of its
    // translation, and a compound legitimately differs from its head: measured
    // on a real glossary, 23 of 25 "conflicts" were pairs like "GoMotion"
    // (neuter) against "GoMotion ant virus" (masculine, because "вирус" is) —
    // noise that buried the two real ones, "Ben Brie"=m against "Brie"=f.
    const isName = e => e.term.type === 'name';
    const genderConflicts = [];
    for (const { outer, inner } of nested) {
        if (!isName(outer) || !isName(inner)) continue;
        // A clone's own gender is never used — its prime's is.
        if (isClone(outer) || isClone(inner)) continue;
        if (outer.gender && inner.gender && outer.gender !== inner.gender) {
            genderConflicts.push({ outer, inner });
        }
    }

    // --- a clone rendered differently from its prime ---
    // A link says the two are one person, so the tolerance the nested check
    // needs for strangers is out of place: the clone's translation must share a
    // whole word with the prime's. The stem comparison above lets «Редмен» pass
    // against «Рекс Редман» — one letter apart, and exactly the kind of drift the
    // link exists to stop. Unlike nesting, this also covers forms that share no
    // word in the original ("the Phoenix" = Maria Johnson), where it is simply
    // not asked: a title translates on its own.
    const words = s => String(s || '').toLowerCase().split(/[\s\-–—.,]+/u).filter(Boolean);
    const inconsistentClones = [];
    for (const e of entries) {
        const p = links.prime[e.index];
        if (p == null) continue;
        const prime = entries[p];
        const sharesOriginal = words(e.original).some(w => words(prime.original).includes(w));
        if (!sharesOriginal) continue;
        const primeWords = words(prime.term.translation);
        if (!words(e.term.translation).some(w => primeWords.includes(w))) inconsistentClones.push({ clone: e, prime });
    }

    // --- forms that could be linked to the person they name ---
    // "Johnson" and "Ms Johnson" are both one surname, give or take a form of
    // address; if exactly one fuller name carries that surname, they are almost
    // certainly that person, and the editor offers to link them. Two fuller
    // names — Rex and Candy Redman — mean a family, and nothing is offered:
    // picking one would be a guess, and a wrong link hands one person's dossier
    // to another. An offer, never an edit: the button is the person's call.
    const core = e => words(e.original).filter(w => !TITLES.has(w.replace(/\.$/, '')));
    const linkHints = [];
    const hasClones = new Set(links.prime.filter(p => p != null));
    for (const e of entries) {
        if (!isName(e) || isClone(e) || hasClones.has(e.index)) continue;
        if (linkTarget(e.term.notes) !== null) continue;   // a broken link is reported as such
        const own = core(e);
        if (own.length !== 1) continue;
        const fuller = entries.filter(o => o !== e && isName(o) && !isClone(o)
            && core(o).length >= 2 && core(o).includes(own[0]));
        if (fuller.length === 1) linkHints.push({ entry: e, prime: fuller[0] });
    }

    // Pronoun evidence is a hint for a human, never a verdict: it is solid on
    // frequently mentioned bare names and unreliable on titled forms
    // ("Ms. Barnaby") and place names ("Portobello"), where the pronouns it
    // counts belong to whoever the sentence goes on to talk about. Sorted by
    // strength of evidence so the trustworthy rows come first.
    const byEvidence = (a, b) => (b.masculine + b.feminine) - (a.masculine + a.feminine);

    const missingGender = entries
        .filter(e => e.term.type === 'name' && !e.gender && e.count > 0 && !isClone(e))
        .map(e => ({ entry: e, ...genderFromPronouns(sourceText, e.original) }))
        .filter(x => x.gender)
        .sort(byEvidence);

    const wrongGender = entries
        .filter(e => e.term.type === 'name' && e.gender && e.count > 0 && !isClone(e))
        .map(e => ({ entry: e, ...genderFromPronouns(sourceText, e.original) }))
        .filter(x => x.gender && x.gender !== x.entry.gender)
        .sort(byEvidence);

    return {
        entries,
        zeroOccurrence: entries.filter(e => e.count === 0),
        untranslated: entries.filter(e => e.original && String(e.term.translation || '').trim() === e.original),
        caseDuplicates,
        nested,
        inconsistentNested,
        inconsistentClones,
        linkHints,
        brokenLinks: links.broken.map(b => ({ ...b, entry: entries[b.index] })),
        genderConflicts,
        missingGender,
        wrongGender,
    };
}

// Forms of address, which make "Ms Johnson" the same surname as "Johnson".
// Lower-case, without the full stop. English only, like the article allowance
// in the matcher: that is the source language every book so far has had.
const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'doctor', 'prof', 'professor',
    'sir', 'dame', 'lady', 'lord', 'madam', 'madame', 'captain', 'capt', 'detective',
    'sergeant', 'sgt', 'inspector', 'officer', 'agent', 'uncle', 'aunt']);

const LINK_PROBLEM = {
    notName: 'клоном может быть только запись с типом «имя»',
    missing: 'нет записи-имени с таким оригиналом или переводом',
    ambiguous: 'таких записей несколько',
    self: 'запись ссылается на себя',
    chain: 'главная запись сама клон — ссылайтесь на её главную',
};

/**
 * The same findings, flattened to one entry per glossary row so a table can
 * mark them. The GUI and the CLI report must agree, so both read this rather
 * than each deciding for itself what counts as a problem.
 *
 * @returns {Array<Array<{kind: string, detail: string}>>} indexed like the glossary
 */
export function glossaryFindings(glossary, sourceText) {
    const a = analyzeGlossary(glossary, sourceText);
    const findings = glossary.map(() => []);
    const push = (index, kind, detail) => {
        if (index >= 0 && findings[index]) findings[index].push({ kind, detail });
    };

    for (const e of a.zeroOccurrence) push(e.index, 'absent', 'не встречается в тексте');
    for (const e of a.untranslated) push(e.index, 'untranslated', 'перевод совпадает с оригиналом');
    // Length is NOT marked. It was, back when the cheat sheet matched by
    // substring and a short entry really did catch everything ("AR" fired on
    // 3543 fragments, "M" on 10577). Matching by word boundary settled that:
    // measured across five glossaries, 104 entries of three characters or less
    // now hit only their own word, and the list is mostly the cast — Bob 44×,
    // Ida 66×, Tom 115×, Ben 71×, Zee 89×. Flagging the main characters of the
    // book as suspicious buries the findings that mean something.

    for (const group of a.caseDuplicates) {
        const forms = group.map(e => `"${e.original}"`).join(' = ');
        for (const e of group) push(e.index, 'caseDuplicate', `различается только регистром: ${forms}`);
    }
    // Nesting is not marked on its own — a book that says both "Roger Coolidge"
    // and "Coolidge" needs both entries, and flagging that is noise (40 of 43
    // pairs on one glossary were perfectly fine). What is marked is the shared
    // name coming out spelled two different ways.
    for (const { outer, inner } of a.inconsistentNested) {
        const detail = `«${outer.original}» → «${outer.term.translation}», но «${inner.original}» → «${inner.term.translation}»`;
        push(outer.index, 'inconsistent', detail);
        push(inner.index, 'inconsistent', detail);
    }
    for (const { clone, prime } of a.inconsistentClones) {
        const detail = `клон «${clone.original}» → «${clone.term.translation}», но главная «${prime.original}» → «${prime.term.translation}»`;
        push(clone.index, 'inconsistent', detail);
        push(prime.index, 'inconsistent', detail);
    }
    for (const { entry, prime } of a.linkHints) {
        findings[entry.index]?.push({ kind: 'linkHint', prime: prime.original, detail: `похоже на форму имени «${prime.original}» — можно связать` });
    }
    for (const b of a.brokenLinks) push(b.index, 'badLink', `ссылка «= ${b.target}» не работает: ${LINK_PROBLEM[b.reason]}`);
    for (const { outer, inner } of a.genderConflicts) {
        push(outer.index, 'genderConflict', `пол ${outer.gender} против ${inner.gender} у "${inner.original}"`);
        push(inner.index, 'genderConflict', `пол ${inner.gender} против ${outer.gender} у "${outer.original}"`);
    }
    for (const { entry, gender, masculine, feminine } of a.missingGender) {
        push(entry.index, 'genderHint', `пол не указан, текст подсказывает ${gender} (муж ${masculine} / жен ${feminine})`);
    }
    for (const { entry, gender, masculine, feminine } of a.wrongGender) {
        push(entry.index, 'genderMismatch', `указан ${entry.gender}, по тексту ${gender} (муж ${masculine} / жен ${feminine})`);
    }
    return findings;
}

function report(a, glossary) {
    const line = (label, value) => console.log(`  ${String(label).padEnd(46)} ${value}`);
    console.log(`\n=== Гигиена глоссария: ${glossary.length} записей ===\n`);

    line('не встречаются в тексте ни разу', a.zeroOccurrence.length);
    for (const e of a.zeroOccurrence.slice(0, 8)) console.log(`      · ${e.original}`);

    line('перевод совпадает с оригиналом', a.untranslated.length);
    for (const e of a.untranslated.slice(0, 8)) console.log(`      · ${e.original}`);

    line('различаются только регистром', a.caseDuplicates.length);
    for (const g of a.caseDuplicates.slice(0, 8)) {
        console.log(`      · ${g.map(e => `"${e.original}" (${e.count}×)`).join('  =  ')}`);
    }

    const nestedNames = a.nested.filter(n => n.bothNames);
    line('вложенные имена (норма, если перевод согласован)', `${nestedNames.length} пар`);
    line('  из них общая часть переведена ПО-РАЗНОМУ', a.inconsistentNested.length);
    for (const { outer, inner } of a.inconsistentNested.slice(0, 8)) {
        console.log(`      · «${outer.original}» → «${outer.term.translation}»  но  «${inner.original}» → «${inner.term.translation}»`);
    }

    line('клон переведён не так, как главная', a.inconsistentClones.length);
    for (const { clone, prime } of a.inconsistentClones.slice(0, 8)) {
        console.log(`      · «${clone.original}» → «${clone.term.translation}»  но  «${prime.original}» → «${prime.term.translation}»`);
    }
    line('ссылки «= главная», которые не работают', a.brokenLinks.length);
    for (const b of a.brokenLinks.slice(0, 8)) console.log(`      · ${b.entry.original}: = ${b.target} — ${LINK_PROBLEM[b.reason]}`);

    line('противоречие по полу внутри одного имени', a.genderConflicts.length);
    for (const { outer, inner } of a.genderConflicts) {
        console.log(`      · "${outer.original}"=${outer.gender}  vs  "${inner.original}"=${inner.gender}`);
    }

    console.log('\n  Пол по местоимениям — ПОДСКАЗКА НА ПРОВЕРКУ, не приговор.');
    console.log('  Надёжна на частых одиночных именах, врёт на составных и топонимах.\n');

    line('пол не проставлен, текст подсказывает', a.missingGender.length);
    for (const { entry, gender, masculine, feminine } of a.missingGender.slice(0, 10)) {
        console.log(`      · ${entry.original} → ${gender}   (муж ${masculine} / жен ${feminine})`);
    }

    line('пол проставлен, но текст говорит иначе', a.wrongGender.length);
    for (const { entry, gender, masculine, feminine } of a.wrongGender.slice(0, 10)) {
        console.log(`      · ${entry.original}: в глоссарии ${entry.gender}, по тексту ${gender}   (муж ${masculine} / жен ${feminine})`);
    }
    console.log();
}

/**
 * Apply only the changes that cannot be wrong: merging entries that differ by
 * case alone, and dropping entries whose text never occurs in the book. Both
 * are verifiable against the source.
 *
 * Deliberately NOT applied: gender (the pronoun hint is measurably wrong on
 * titled forms and place names) and nested names (deciding whether "Smith" is
 * Sue or a different Smith is a judgement call, and a wrong merge silently
 * corrupts every chunk after it). Those stay in the report for a human.
 */
function applySafeFixes(glossary, a) {
    const dropped = new Set();
    let merged = 0;

    for (const group of a.caseDuplicates) {
        const keep = group.reduce((best, e) => (e.count > best.count ? e : best), group[0]);
        keep.term.original = group.reduce((form, e) => betterSurfaceForm(form, e.original), keep.original);
        for (const e of group) {
            if (e === keep) continue;
            // keep whatever fields the discarded twin filled in
            for (const field of ['translation', 'gender', 'notes', 'type']) {
                if (!keep.term[field] && e.term[field]) keep.term[field] = e.term[field];
            }
            dropped.add(e.index);
            merged++;
        }
    }

    for (const e of a.zeroOccurrence) dropped.add(e.index);

    const cleaned = glossary.filter((_, i) => !dropped.has(i));
    return { cleaned, merged, removed: a.zeroOccurrence.length };
}

function main() {
    const args = process.argv.slice(2);
    const fileArg = args.find(x => x.startsWith('--file='));
    const apply = args.includes('--apply');

    if (!fileArg) {
        console.error('Usage: node src_v4/tools/glossary_hygiene.js --file=<path/to/book.txt> [--apply]');
        process.exit(1);
    }

    const filePath = fileArg.split('=').slice(1).join('=');
    const filePrefix = path.basename(filePath, path.extname(filePath));
    const state = new ProjectState(process.cwd(), filePrefix);
    state.load();

    const glossaryPath = state.getGlossaryPath();
    if (!fs.existsSync(glossaryPath)) {
        console.error(`[Error] Glossary not found: ${glossaryPath}`);
        process.exit(1);
    }
    const glossary = JSON.parse(fs.readFileSync(glossaryPath, 'utf-8'));

    // Source text: prefer the chunks in the state (that is what the pipeline
    // actually translates); fall back to the file on disk.
    const chunks = state.getChunks();
    const sourceText = chunks.length
        ? chunks.map(c => c.original).join('\n')
        : fs.readFileSync(filePath, 'utf-8');

    const analysis = analyzeGlossary(glossary, sourceText);
    report(analysis, glossary);

    if (!apply) {
        console.log('Ничего не изменено. Запустите с --apply, чтобы применить проверяемую часть:');
        console.log('  слияние записей, различающихся только регистром, и удаление записей с нулевыми вхождениями.');
        console.log('Пол, вложенные имена и подозрительные записи не трогаются — это решение за человеком.\n');
        return;
    }

    // Never overwrite an existing backup. A second --apply run is harmless in
    // itself (the fixes are idempotent), but copying the already-cleaned file
    // over the .bak destroys the only copy of the original — which is exactly
    // what happened the first time this ran twice on the same project.
    let backupPath = `${glossaryPath}.bak`;
    if (fs.existsSync(backupPath)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        backupPath = `${glossaryPath}.${stamp}.bak`;
    }
    fs.copyFileSync(glossaryPath, backupPath);

    const { cleaned, merged, removed } = applySafeFixes(glossary, analysis);
    writeFileAtomic(glossaryPath, JSON.stringify(cleaned, null, 2));

    console.log(`Применено: слито регистровых дублей ${merged}, удалено записей ${removed}.`);
    console.log(`Было ${glossary.length} записей, стало ${cleaned.length}.`);
    console.log(`Резервная копия: ${path.basename(backupPath)}\n`);
}

// Run only when invoked directly: the GUI imports glossaryFindings from here.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
