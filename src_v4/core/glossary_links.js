/**
 * Prime and clone entries: several surface forms of one person.
 *
 * A book calls the same woman "Maria Johnson", "Johnson" and "Ms Johnson", and
 * the glossary needs all three — the cheat sheet finds an entry by its own
 * spelling, and "Ms Johnson → г-жа Джонсон" carries a rule of its own. What it
 * does not need is three dossiers. Extraction writes each form's note from the
 * batch it happened to see, so the full name knows she is the supreme leader
 * while the surname is "участница событий", and a chunk that says only
 * "Johnson" gets the thin one. Merging the forms is no answer: it deletes a
 * form the text uses, and a surname can belong to a whole family.
 *
 * So a form points at the entry that speaks for the person. A clone's note is
 * the link and nothing else:
 *
 *     Johnson    → Джонсон     notes: "= Maria Johnson"
 *
 * and the clone then takes its gender and note from the prime. The link lives
 * in the note because that is a field every glossary already has, the editor
 * already edits, and the review model already reads — a new field would need
 * all three taught about it.
 *
 * The syntax is strict on purpose. Notes are free text, and «Мария Джонсон;
 * дочь» names a different person than it seems to — reading links out of prose
 * would bind the wrong people. Anything that does not resolve cleanly stays an
 * ordinary note.
 */

// A note long enough to be a paragraph is a dossier, not a cheat-sheet entry:
// the cheat sheet cuts a note at this length. Measured on real glossaries:
// median note 32 characters, 90th percentile 51.
export const MAX_NOTE_CHARS = 120;

const LINK_RE = /^=\s*(\S[\s\S]*?)\s*$/;

/** The text a note links to, or null when the note is not a link. */
export function linkTarget(notes) {
    const m = LINK_RE.exec(String(notes || '').trim());
    return m ? m[1] : null;
}

/**
 * Resolve every link in the glossary.
 *
 * The target is named by the prime's original or its translation, exactly as
 * written, and must be one name entry that is not a clone itself: a chain would
 * make "who speaks for this person" depend on following it, and a cycle would
 * make it unanswerable. A link that fails any of that is reported with the
 * reason and the entry is treated as standing alone.
 *
 * @returns {{prime: Array<number|null>, broken: Array<{index: number, target: string,
 *            reason: 'notName'|'missing'|'ambiguous'|'self'|'chain'}>}}
 *   `prime[i]` is the index of entry i's prime, or null.
 */
export function resolveLinks(glossary) {
    const terms = Array.isArray(glossary) ? glossary : [];
    const targets = terms.map(t => linkTarget(t?.notes));
    const prime = terms.map(() => null);
    const broken = [];

    terms.forEach((term, index) => {
        const target = targets[index];
        if (target === null) return;
        if (term?.type !== 'name') { broken.push({ index, target, reason: 'notName' }); return; }

        const found = [];
        terms.forEach((other, j) => {
            if (other?.type !== 'name') return;
            if (String(other.original || '').trim() === target
                || String(other.translation || '').trim() === target) found.push(j);
        });
        const others = found.filter(j => j !== index);

        if (!found.length) broken.push({ index, target, reason: 'missing' });
        else if (!others.length) broken.push({ index, target, reason: 'self' });
        else if (others.length > 1) broken.push({ index, target, reason: 'ambiguous' });
        else if (targets[others[0]] !== null) broken.push({ index, target, reason: 'chain' });
        else prime[index] = others[0];
    });

    return { prime, broken };
}

// Forms of address, which make "Ms Johnson" the same surname as "Johnson".
// Lower-case, without the full stop. English only, like the article allowance
// in the matcher: that is the source language every book so far has had.
const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'doctor', 'prof', 'professor',
    'sir', 'dame', 'lady', 'lord', 'madam', 'madame', 'captain', 'capt', 'detective',
    'sergeant', 'sgt', 'inspector', 'officer', 'agent', 'uncle', 'aunt']);

const words = s => String(s || '').toLowerCase().split(/[\s\-–—.,:;!?"«»“”()]+/u).filter(Boolean);

/** The words of a name that are not forms of address. */
function coreWords(original) {
    return words(original).filter(w => !TITLES.has(w));
}

/** Do two strings share a whole word, case aside? */
export function shareWord(a, b) {
    const wb = words(b);
    return words(a).some(w => wb.includes(w));
}

/**
 * The people of a glossary as the editor groups them: a prime and its forms.
 *
 * A group gathers the clones already linked to an entry and the forms that
 * look like it: names that, without forms of address, are one word found in a
 * fuller name. When exactly one fuller name has that word the form is
 * `suggested`; when several do — "Redman" beside Rex and Candy Redman — it is
 * `ambiguous` and appears in each of their groups, so the choice is on screen
 * and nothing is decided for the person.
 *
 * @returns {Array<{prime: number, members: Array<{index: number,
 *            state: 'linked'|'suggested'|'ambiguous'}>}>}
 */
export function personGroups(glossary) {
    const terms = Array.isArray(glossary) ? glossary : [];
    const { prime } = resolveLinks(terms);
    const isName = i => terms[i]?.type === 'name' && String(terms[i].original || '').trim();
    const primes = new Set(prime.filter(p => p != null));

    const groups = new Map();
    const add = (p, index, state) => {
        if (!groups.has(p)) groups.set(p, []);
        groups.get(p).push({ index, state });
    };
    prime.forEach((p, i) => { if (p != null) add(p, i, 'linked'); });

    const core = terms.map(t => coreWords(t?.original));
    terms.forEach((term, i) => {
        if (!isName(i) || prime[i] != null || primes.has(i)) return;
        if (linkTarget(term.notes) !== null) return;   // a broken link is reported as such
        if (core[i].length !== 1) return;
        const fuller = [];
        terms.forEach((_, j) => {
            if (j !== i && isName(j) && prime[j] == null && core[j].length >= 2 && core[j].includes(core[i][0])) fuller.push(j);
        });
        for (const j of fuller) add(j, i, fuller.length === 1 ? 'suggested' : 'ambiguous');
    });

    return [...groups].sort((a, b) => a[0] - b[0]).map(([p, members]) => ({ prime: p, members }));
}

const ARTICLES = new Set(['the', 'a', 'an']);

/**
 * Are two names forms of one name — and if so, which is the fuller?
 *
 * Which is fuller says nothing about which entry speaks for the person — "Old
 * Growth" is fuller than "Growth" and is its past version — so callers use it
 * to tell a form from a duplicate, not to pick a prime.
 *
 * "Maria Johnson" and "Johnson", "Mr Stephano" and "Stephano": the words of
 * one, forms of address aside, are all in the other. Those want a link, not a
 * merge — merging deletes a spelling the book uses and, more often than not,
 * the entry that carried the full dossier. Two that differ only by an article
 * or by case are a plain duplicate instead: "The Scavenger" and "Scavenger"
 * are one spelling, and a merge loses nothing.
 *
 * @returns {'a'|'b'|'either'|null} which one is fuller; 'either' when they
 *   differ only by forms of address; null when they are not forms of one name.
 */
export function fullerForm(a, b) {
    const bare = s => words(s).filter(w => !ARTICLES.has(w));
    const wa = bare(a), wb = bare(b);
    if (wa.join(' ') === wb.join(' ')) return null;
    const ca = wa.filter(w => !TITLES.has(w)), cb = wb.filter(w => !TITLES.has(w));
    if (!ca.length || !cb.length) return null;
    const aInB = ca.every(w => cb.includes(w)), bInA = cb.every(w => ca.includes(w));
    if (aInB && bInA) return 'either';
    if (aInB) return 'b';
    if (bInA) return 'a';
    return null;
}
