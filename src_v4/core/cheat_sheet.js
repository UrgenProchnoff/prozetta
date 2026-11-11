/**
 * The cheat sheet: the part of the glossary one chunk needs, as the lines the
 * translation prompt carries.
 */
import { entryRegex } from './text_stats.js';
import { linkTarget, MAX_NOTE_CHARS } from './glossary_links.js';

// Substring matching turned nearly half the cheat sheet into noise: "HA" fired
// inside "charles", "M" inside "memory", "ICE" inside "noticed". entryRegex
// matches whole words, falls back to a plain substring in Chinese or Japanese,
// where nothing is space-separated, and matches a name with its case, so the
// narrator Face is not handed over for every "face".
const termRegexCache = new Map();

function cachedTermRegex(term) {
    const key = `${term.type === 'name' ? 'name' : 'term'}|${term.original}`;
    let re = termRegexCache.get(key);
    if (!re) {
        re = entryRegex(term);
        termRegexCache.set(key, re);
    }
    return re;
}

/**
 * Names whose gender the glossary states two ways.
 *
 * Extraction files one character under several entries, and they can disagree —
 * "Detective Sergeant Smith"=m beside "Sue Smith"=f for the same woman. Passing
 * that into the prompt is worse than passing nothing: it would order masculine
 * agreement in a female narrator's chapters. The hygiene tool reports these for
 * a human to settle, but the pipeline must stay safe on a glossary nobody has
 * cleaned yet, so a contradicted name simply travels without its gender.
 *
 * Only the bare name loses it. "Kay Coolidge" is one person whatever "Coolidge"
 * says — it is the surname that can belong to her or to her husband — and
 * dropping the full name's gender too sent the translator a widow with no
 * gender at all.
 *
 * @param {Array<object>} glossary
 * @param {Array<number|null>} [prime]  from resolveLinks: entry i's prime, or null
 * @returns {Set<string>} lower-cased originals
 */
export function contradictedNames(glossary, prime = []) {
    // A clone's own gender is never sent — its prime's is — so it can contradict
    // nothing.
    const own = glossary.filter((_, i) => prime[i] == null);
    const singles = new Map();
    for (const term of own) {
        const name = String(term?.original || '').trim();
        if (term?.type === 'name' && name && !/\s/.test(name)) singles.set(name.toLowerCase(), term);
    }

    const contradicted = new Set();
    for (const term of own) {
        const name = String(term?.original || '').trim();
        if (term?.type !== 'name' || !name || !/\s/.test(name)) continue;
        for (const part of name.split(/\s+/)) {
            if (part.length <= 2) continue;
            const inner = singles.get(part.toLowerCase());
            if (inner && term.gender && inner.gender && term.gender !== inner.gender) {
                contradicted.add(String(inner.original).toLowerCase());
            }
        }
    }
    return contradicted;
}

const GENDER_WORD = { m: 'муж', f: 'жен', n: 'ср' };

/**
 * The cheat sheet for one chunk: every glossary entry the text mentions.
 *
 * Carries more than the translation. Gender is what Russian agreement needs for
 * any character named in the chunk ("Элейн сказала", not "сказал"), and the
 * note is what tells a translator which of two same-named people this is. Both
 * sat unused in the glossary while the prompt saw only "original -> translation".
 *
 * Forms of one person share a line: a chunk saying "Maria Johnson" also matches
 * "Johnson", and listing both repeats the person, once with the thin note. The
 * line names the forms found, and the gender and note are the prime's — so a
 * chunk that says only "Johnson" still learns who she is.
 *
 * @param {string} text  the chunk's source text
 * @param {Array<object>} glossary
 * @param {Set<string>} [contradicted]  from contradictedNames
 * @param {Array<number|null>} [prime]  from resolveLinks
 * @returns {string} one line per person or term, empty when nothing matches
 */
export function cheatSheet(text, glossary, contradicted = new Set(), prime = []) {
    const groups = new Map(); // prime index -> indices of its forms found here
    glossary.forEach((term, index) => {
        const original = String(term?.original || '').trim();
        if (!original) return;
        if (!cachedTermRegex({ original, type: term.type }).test(text)) return;
        const root = prime[index] ?? index;
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(index);
    });

    const hits = [];
    for (const [root, found] of groups) {
        // The prime first when it is among them: it is the full form.
        found.sort((a, b) => (a === root ? -1 : b === root ? 1 : a - b));
        const head = glossary[root];
        const originals = found.map(i => String(glossary[i].original).trim());
        let line = `${originals.join(' / ')} -> ${found.map(i => glossary[i].translation).join(' / ')}`;

        // Gender only for people: on a term it is the grammatical gender of the
        // translation, which the model can see for itself and which is wrong
        // often enough in the glossary to be worth leaving out.
        const gender = head.type === 'name' ? GENDER_WORD[head.gender] : null;
        if (gender && !contradicted.has(String(head.original).trim().toLowerCase())) line += ` (${gender})`;

        // A link that resolved to nothing tells the translator nothing either.
        const note = linkTarget(head.notes) === null ? String(head.notes || '').trim() : '';
        if (note) line += ` — ${note.length > MAX_NOTE_CHARS ? note.slice(0, MAX_NOTE_CHARS) + '…' : note}`;

        hits.push(line);
    }
    return hits.join('\n');
}
