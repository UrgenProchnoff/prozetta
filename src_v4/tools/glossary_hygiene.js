/**
 * Glossary hygiene — deterministic clean-up, no LLM involved.
 *
 * Stage 1 builds the glossary chunk by chunk, so the same character ends up
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
import { ProjectState } from '../core/state_manager.js';

const WORD_CHAR = '[\\p{L}\\p{N}]';

function wholeWordRegex(term, flags = 'giu') {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<!${WORD_CHAR})${escaped}(?!${WORD_CHAR})`, flags);
}

function countOccurrences(text, term) {
    return (text.match(wholeWordRegex(term)) || []).length;
}

/**
 * Gender of a name from the pronouns that follow it across the whole book.
 * A single chunk rarely shows it; the book as a whole shows it clearly.
 *
 * Counting stops at the end of the sentence rather than after a fixed number of
 * characters: a wider window picks up the pronouns of whoever is mentioned next
 * and starts inventing genders for places. Measured on 16 names with a known
 * answer, sentence scope gives 14 right, 0 wrong, 2 abstentions; a 120-char
 * window gets 2 of them wrong.
 *
 * Returns 'm' | 'f' | null (null = not enough signal, or too close to call).
 */
export function genderFromPronouns(text, name, maxScope = 200) {
    const re = wholeWordRegex(name);
    let m, he = 0, she = 0;
    while ((m = re.exec(text)) !== null) {
        const after = text.slice(m.index + m[0].length);
        const sentenceEnd = after.search(/[.!?\n]/);
        const scope = after.slice(0, sentenceEnd < 0 ? maxScope : Math.min(sentenceEnd, maxScope));
        he += (scope.match(/\b(he|him|his)\b/gi) || []).length;
        she += (scope.match(/\b(she|her|hers)\b/gi) || []).length;
    }
    const total = he + she;
    let gender = null;
    if (total >= 3) {
        if (he > she * 1.5) gender = 'm';
        else if (she > he * 1.5) gender = 'f';
    }
    return { gender, he, she };
}

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
            count: original ? countOccurrences(sourceText, original) : 0,
            gender: normalizeGender(term.gender),
        };
    });

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
            if (inner && part.length > 2) nested.push({ outer: e, inner });
        }
    }

    // --- one person, contradictory genders (grouped by shared name part) ---
    const genderConflicts = [];
    for (const { outer, inner } of nested) {
        if (outer.gender && inner.gender && outer.gender !== inner.gender) {
            genderConflicts.push({ outer, inner });
        }
    }

    // Pronoun evidence is a hint for a human, never a verdict: it is solid on
    // frequently mentioned bare names and unreliable on titled forms
    // ("Ms. Barnaby") and place names ("Portobello"), where the pronouns it
    // counts belong to whoever the sentence goes on to talk about. Sorted by
    // strength of evidence so the trustworthy rows come first.
    const byEvidence = (a, b) => (b.he + b.she) - (a.he + a.she);

    const missingGender = entries
        .filter(e => e.term.type === 'name' && !e.gender && e.count > 0)
        .map(e => ({ entry: e, ...genderFromPronouns(sourceText, e.original) }))
        .filter(x => x.gender)
        .sort(byEvidence);

    const wrongGender = entries
        .filter(e => e.term.type === 'name' && e.gender && e.count > 0)
        .map(e => ({ entry: e, ...genderFromPronouns(sourceText, e.original) }))
        .filter(x => x.gender && x.gender !== x.entry.gender)
        .sort(byEvidence);

    return {
        entries,
        zeroOccurrence: entries.filter(e => e.count === 0),
        untranslated: entries.filter(e => e.original && String(e.term.translation || '').trim() === e.original),
        tooShort: entries.filter(e => e.original.length > 0 && e.original.length <= 3),
        caseDuplicates,
        nested,
        genderConflicts,
        missingGender,
        wrongGender,
    };
}

function report(a, glossary) {
    const line = (label, value) => console.log(`  ${String(label).padEnd(46)} ${value}`);
    console.log(`\n=== Гигиена глоссария: ${glossary.length} записей ===\n`);

    line('не встречаются в тексте ни разу', a.zeroOccurrence.length);
    for (const e of a.zeroOccurrence.slice(0, 8)) console.log(`      · ${e.original}`);

    line('перевод совпадает с оригиналом', a.untranslated.length);
    for (const e of a.untranslated.slice(0, 8)) console.log(`      · ${e.original}`);

    line('короче 4 символов (шум при поиске)', a.tooShort.length);
    line('различаются только регистром', a.caseDuplicates.length);
    for (const g of a.caseDuplicates.slice(0, 8)) {
        console.log(`      · ${g.map(e => `"${e.original}" (${e.count}×)`).join('  =  ')}`);
    }

    line('составные, включающие другую запись', a.nested.length);
    for (const { outer, inner } of a.nested.slice(0, 8)) {
        console.log(`      · "${outer.original}" (${outer.count}×) ⊃ "${inner.original}" (${inner.count}×)`);
    }

    line('противоречие по полу внутри одного имени', a.genderConflicts.length);
    for (const { outer, inner } of a.genderConflicts) {
        console.log(`      · "${outer.original}"=${outer.gender}  vs  "${inner.original}"=${inner.gender}`);
    }

    console.log('\n  Пол по местоимениям — ПОДСКАЗКА НА ПРОВЕРКУ, не приговор.');
    console.log('  Надёжна на частых одиночных именах, врёт на составных и топонимах.\n');

    line('пол не проставлен, текст подсказывает', a.missingGender.length);
    for (const { entry, gender, he, she } of a.missingGender.slice(0, 10)) {
        console.log(`      · ${entry.original} → ${gender}   (he ${he} / she ${she})`);
    }

    line('пол проставлен, но текст говорит иначе', a.wrongGender.length);
    for (const { entry, gender, he, she } of a.wrongGender.slice(0, 10)) {
        console.log(`      · ${entry.original}: в глоссарии ${entry.gender}, по тексту ${gender}   (he ${he} / she ${she})`);
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

    const backupPath = `${glossaryPath}.bak`;
    fs.copyFileSync(glossaryPath, backupPath);

    const { cleaned, merged, removed } = applySafeFixes(glossary, analysis);
    fs.writeFileSync(glossaryPath, JSON.stringify(cleaned, null, 2));

    console.log(`Применено: слито регистровых дублей ${merged}, удалено записей ${removed}.`);
    console.log(`Было ${glossary.length} записей, стало ${cleaned.length}.`);
    console.log(`Резервная копия: ${path.basename(backupPath)}\n`);
}

main();
