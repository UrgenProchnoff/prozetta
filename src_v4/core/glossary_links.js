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
