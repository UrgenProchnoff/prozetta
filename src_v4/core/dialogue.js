/**
 * Checking a translation against the way its language sets direct speech.
 *
 * Every language marks dialogue with punctuation at the start of a line: “ in
 * English, — in Russian and Spanish, „ in German, 「 in Japanese. Which one to
 * use is a norm of the target language, decided once in the passport before a
 * word is translated. Nothing here decides it.
 *
 * What is here is the count, and it answers a different question: does the
 * finished text keep to what the passport says? An earlier version let the
 * count set the passport as well, seeded from the translation. That is
 * backwards — it makes the majority right by definition, so a book translated
 * badly teaches the passport its own mistake, and a 60/40 split enshrines the
 * 60. The measurement observes; the passport prescribes.
 *
 * Measured across four finished books: Ryuker's translation departs from the
 * Russian convention in 10 lines out of 1445 (0.7%), Morphotrophic in 328 out
 * of 1792 (18%) — including 25 that kept the English “ outright. So the count
 * does separate a consistent book from an inconsistent one, which is all it is
 * asked to do.
 */

// Opening/closing/initial/final punctuation, dashes, and other punctuation:
// wide enough to catch 「, «, „, — and " without naming any of them.
const LEADING_PUNCT = /^[\p{Ps}\p{Pe}\p{Pi}\p{Pf}\p{Pd}\p{Po}]/u;

// A line made of nothing but punctuation and spaces is a scene divider (* * *,
// ---, · · ·), not a line of dialogue. Counting those would let a book with
// forty scene breaks out-vote its own speech marker.
const DIVIDER = /^[\p{P}\p{S}\s]+$/u;

/** Lines of a text, trimmed of leading space, empty and divider lines dropped. */
function speechLines(text) {
    const out = [];
    for (const raw of String(text || '').split('\n')) {
        const line = raw.replace(/^[\s ]+/, '');
        if (!line || DIVIDER.test(line)) continue;
        out.push(line);
    }
    return out;
}

/**
 * Tally of the punctuation each line opens with.
 *
 * @returns {{lines: number, marked: number, tally: Array<[string, number]>}}
 *   `tally` is sorted by count, commonest first.
 */
export function markerTally(text) {
    const counts = new Map();
    const lines = speechLines(text);
    let marked = 0;
    for (const line of lines) {
        if (!LEADING_PUNCT.test(line)) continue;
        marked++;
        const ch = line[0];
        counts.set(ch, (counts.get(ch) || 0) + 1);
    }
    return {
        lines: lines.length,
        marked,
        tally: [...counts.entries()].sort((a, b) => b[1] - a[1]),
    };
}

// Below this share of marked lines a rival is not a competing convention but
// the ordinary punctuation of the language — a parenthesis opening a paragraph,
// an ellipsis, a footnote bracket. Set from the measured books: Morphotrophic's
// rival « holds 17% and is a real second convention; Overtime's ( holds 6% and
// is not.
const RIVAL_SHARE = 0.1;

// A marker claiming fewer lines than this is not evidence of anything. Three
// paragraphs in a novel is a typo, not a convention.
const MIN_MARKED = 8;

/**
 * The convention a text actually follows, and what competes with it.
 *
 * An observation, not a decision — used to report what a finished translation
 * does, and as the fallback reference for a book whose passport predates the
 * dialogue field.
 *
 * Returns `marker: null` when there is nothing to see: a text whose speech is
 * set inside paragraphs rather than broken out gives no line-initial evidence,
 * and guessing from a handful of lines would be worse than saying nothing. That
 * is the policy language.js already takes for an unidentified language —
 * refuse rather than mislead.
 *
 * @returns {{marker: string|null, count: number, share: number, marked: number,
 *            rivals: Array<{marker: string, count: number, share: number}>,
 *            tally: Array<[string, number]>}}
 */
export function dominantMarker(text) {
    const { marked, tally } = markerTally(text);
    const empty = { marker: null, count: 0, share: 0, marked, rivals: [], tally };
    if (!tally.length || marked < MIN_MARKED) return empty;

    const [marker, count] = tally[0];
    const rivals = tally.slice(1)
        .filter(([, n]) => n / marked >= RIVAL_SHARE)
        .map(([m, n]) => ({ marker: m, count: n, share: n / marked }));

    return { marker, count, share: count / marked, marked, rivals, tally };
}

/**
 * How much of the dialogue a text sets with `marker`.
 *
 * Counted against the markers that could be a dialogue convention here — the
 * reference plus anything holding a real share of the book — not against every
 * line that happens to start with punctuation. Overtime opens 77 lines with —
 * and nothing else at that scale, but also six with a bracket and four with an
 * italic star; measured against all of them it scored 85% while departing from
 * the norm in exactly zero chunks, and two numbers that disagree are worse than
 * one.
 */
export function adherence(book, marker) {
    if (!book?.marked || !marker) return null;
    const relevant = book.tally.filter(([m, n]) => m === marker || n / book.marked >= RIVAL_SHARE);
    const total = relevant.reduce((sum, [, n]) => sum + n, 0);
    const count = book.tally.find(([m]) => m === marker)?.[1] || 0;
    return { count, total, share: total ? count / total : 0 };
}

/**
 * A line opening with `marker`, chosen to be shown as an example.
 *
 * The shortest one long enough to be a sentence, not the first one found. The
 * first is whatever the book opens with, which on Morphotrophic is a 400-word
 * paragraph that merely begins with a dash; cut to fit, it ends mid-word and
 * demonstrates nothing. A short complete line shows the whole shape of the
 * convention — opening mark, speech, attribution — in one glance.
 */
export function sampleLine(text, marker) {
    if (!marker) return null;
    let best = null;
    for (const line of speechLines(text)) {
        if (line[0] !== marker || line.length < 12) continue;
        if (!best || line.length < best.length) best = line;
        if (best.length <= 40) break;   // short enough; no point scanning a novel
    }
    if (best) return best.length > 140 ? best.slice(0, 137) + '…' : best;
    // Nothing short: fall back to the first line at all, cut to fit.
    for (const line of speechLines(text)) {
        if (line[0] === marker) return line.length > 140 ? line.slice(0, 137) + '…' : line;
    }
    return null;
}

/**
 * Which chunks depart from the marker the book is supposed to use.
 *
 * `reference` is the passport's marker — the norm of the target language. It
 * falls back to what the text mostly does only when no passport says, which is
 * a worse answer and is meant as one: it can only report that a book disagrees
 * with itself, never that it disagrees with the language.
 *
 * Only a marker that competes across the whole book counts as a departure. The
 * looser rule — any marker out-numbering the reference inside one chunk — reads
 * ordinary typography as dialogue: it flagged a chunk of Ryuker for seventeen
 * lines of `*`, which is a bolded FAQ, and a chunk of Overtime for four, which
 * is a poem in italics. A second convention worth reporting shows up book-wide.
 *
 * Chunks with no marked lines are not deviations — narration without dialogue
 * is not a punctuation choice.
 *
 * @param {Array<{translation?: string, original?: string}>} chunks
 * @param {{marker: string|null, tally: Array<[string, number]>, marked: number}} book
 * @param {string|null} reference  the marker that ought to be used
 * @param {'translation'|'original'} field
 * @returns {Array<{i: number, marker: string, count: number, own: number, sample: string|null}>}
 */
export function deviatingChunks(chunks, book, reference = null, field = 'translation') {
    const marker = reference || book?.marker;
    if (!marker || !book?.marked) return [];

    // Everything else that holds a real share of the book — including whatever
    // the text mostly does, when that is not the marker it ought to be using.
    const competing = new Set(
        book.tally
            .filter(([m, n]) => m !== marker && n / book.marked >= RIVAL_SHARE)
            .map(([m]) => m)
    );
    if (!competing.size) return [];

    const out = [];
    (chunks || []).forEach((chunk, i) => {
        const text = chunk?.[field] || '';
        if (!text) return;
        const { tally } = markerTally(text);
        if (!tally.length) return;
        const own = tally.find(([m]) => m === marker)?.[1] || 0;
        for (const [m, n] of tally) {
            if (!competing.has(m) || n < own) continue;
            out.push({ i, marker: m, count: n, own, sample: sampleLine(text, m) });
            break;
        }
    });
    return out;
}

