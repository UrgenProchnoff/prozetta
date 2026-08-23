/**
 * Glossary entries that describe forms of the same source word.
 *
 * Stage 1b files "replenisher" and "replenishers" as two independent entries and
 * has no way to notice they are one word. On Morphotrophic it gave them two
 * different translations — «восполнитель» and «восстановители» — and a third,
 * «люди-репликаторы», for the compound. The per-chunk cheat sheet then handed
 * the translator whichever entries the chunk happened to match, and the book
 * came out saying all three. The finished translation says «восстановителей» in
 * chunk 2 and «восполнителем» in chunk 66; neither is a translation error, both
 * are the glossary answering the same question twice.
 *
 * Grouping is done by one rule applied to the source side only: one original is
 * a prefix of the other, and what is left over is short and has no space. That
 * is inflection in a suffixing language and nothing else — "Swapper" and
 * "Swapper movement" are not caught, because the leftover is a word.
 *
 * The translations are NOT judged. An earlier version did: it declared a group a
 * conflict when the translations were not in the same prefix relation. On
 * Morphotrophic that was perfect — one group, the real one. On Ryuker it called
 * sixteen groups conflicts and twelve were nothing but Russian morphology:
 * «муравьи GoMotion» against «Муравей GoMotion» (the word order flips), «Адзе»
 * against «Адзы». German would be worse (Buch/Bücher share no prefix), Arabic
 * hopeless, Chinese pointless — it has no inflection to allow for. Guessing at
 * the morphology of a language the code was never told about is how a warning
 * becomes noise.
 *
 * So similarity ranks and never decides: the groups are listed with the least
 * similar translations first, and a person looks. Nothing can be hidden by a bad
 * ranking on an unfamiliar language — a bad ranking only reorders the list.
 */

// Words that are grammar rather than the term: one entry filed with an article
// and one without is the same entry twice, which is precisely the duplication
// worth showing. Kept to articles — anything longer starts merging terms that
// differ in meaning.
const GRAMMAR_WORDS = /^(the|a|an|le|la|les|un|une|der|die|das|el|los|las)$/i;

/** Is `b` `a` plus a short wordless tail — the same word, inflected? */
function inflectionOf(a, b) {
    const x = strip(a);
    const y = strip(b);
    if (x.length < 3 || y.length < 3) return false;
    const [short, long] = x.length <= y.length ? [x, y] : [y, x];
    if (short === long) return true;
    if (!long.startsWith(short)) return false;
    const tail = long.slice(short.length);
    return tail.length <= 3 && !/\s/.test(tail);
}

/**
 * The entry without its leading article.
 *
 * Measured on Morphotrophic, where the glossary holds both "exchange" → «обмен»
 * and "the exchange" → «Обмен», so the book capitalises the same ritual two ways
 * with no system. The prefix rule missed it — "the exchange" does not start with
 * "exchange" — and it is exactly the kind of duplication the grouping is for.
 */
function strip(text) {
    const words = String(text || '').trim().toLowerCase().split(/\s+/);
    return (words.length > 1 && GRAMMAR_WORDS.test(words[0]) ? words.slice(1) : words).join(' ');
}

/** Character bigrams of a string, for comparing two texts in any script. */
function bigrams(text) {
    const s = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const out = new Set();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    if (!out.size && s) out.add(s);
    return out;
}

/**
 * How unlike two strings are, 0 (same) to 1 (nothing shared).
 *
 * Bigram overlap rather than a common prefix: it survives a word order that
 * flips between languages, which a prefix comparison does not. Used only to sort.
 */
export function dissimilarity(a, b) {
    const A = bigrams(a), B = bigrams(b);
    if (!A.size || !B.size) return 1;
    let shared = 0;
    for (const g of A) if (B.has(g)) shared++;
    return 1 - shared / (A.size + B.size - shared);
}

/**
 * Groups of entries whose originals are forms of one word and whose translations
 * are not all the same.
 *
 * @param {Array<{original: string, translation: string}>} glossary
 * @returns {Array<{entries: Array<{index: number, original: string, translation: string}>,
 *                  translations: string[], spread: number}>}
 *   Sorted by `spread` — the widest disagreement first.
 */
export function inflectionGroups(glossary) {
    const rows = (glossary || [])
        .map((t, index) => ({ index, original: String(t?.original || '').trim(), translation: String(t?.translation || '').trim() }))
        .filter(r => r.original && r.translation);

    // Union-find, so "cyte"/"cytes"/"cytes'" land in one group rather than three
    // overlapping pairs.
    const parent = rows.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

    for (let i = 0; i < rows.length; i++) {
        for (let j = i + 1; j < rows.length; j++) {
            if (inflectionOf(rows[i].original, rows[j].original)) union(i, j);
        }
    }

    const buckets = new Map();
    rows.forEach((row, i) => {
        const root = find(i);
        if (!buckets.has(root)) buckets.set(root, []);
        buckets.get(root).push(row);
    });

    const groups = [];
    for (const entries of buckets.values()) {
        if (entries.length < 2) continue;
        // Compared as written, not lowercased. A capital is a difference and
        // sometimes the whole defect: the glossary holds "exchange" → «обмен» and
        // "the exchange" → «Обмен», so the same ritual is a common noun in one
        // chapter and a proper one in the next. Folded to lower case that group
        // looked like agreement and was dropped.
        const translations = [...new Set(entries.map(e => e.translation))];
        // Every form translated identically is the glossary agreeing with itself.
        if (translations.length < 2) continue;

        let spread = 0;
        for (let i = 0; i < entries.length; i++) {
            for (let j = i + 1; j < entries.length; j++) {
                spread = Math.max(spread, dissimilarity(entries[i].translation, entries[j].translation));
            }
        }

        // A difference of case only. Bigram overlap reads «обмен» against «Обмен»
        // as identical and ranks the pair last, under ten harmless plurals — but
        // this is the one kind of disagreement that is certain rather than
        // probable. Everything the ranking usually puts low is morphology that is
        // probably fine; a word capitalised two ways is a word capitalised two
        // ways, and it made the same ritual a proper noun in one chapter of
        // Morphotrophic and a common one in the next. So it is placed above the
        // uncertain and below the outright different.
        const caseOnly = new Set(translations.map(x => x.toLowerCase())).size < translations.length;
        if (caseOnly) spread = Math.max(spread, 0.75);
        groups.push({ entries, translations: entries.map(e => e.translation), spread });
    }

    return groups.sort((a, b) => b.spread - a.spread);
}
