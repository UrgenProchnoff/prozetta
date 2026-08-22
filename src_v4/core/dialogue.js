/**
 * How a book sets direct speech — counted, not looked up.
 *
 * Every language marks dialogue with punctuation at the start of a line: “ in
 * English, — in Russian and Spanish, „ in German, 「 in Japanese. Which one a
 * book uses is therefore a countable fact about the book, and counting it needs
 * no table of languages and no model call.
 *
 * A table was the obvious alternative and it would have been wrong. language.js
 * already carries `quotePairs` for six languages and five scripts, and not one
 * entry lists a dash — so a table lookup would have decided that the Russian
 * translation of Morphotrophic is a book set in quotation marks, when 1464 of
 * its 1792 speech paragraphs open with —. Counting cannot make that mistake,
 * because it assumes nothing.
 *
 * Measured across four finished books: Ryuker's translation deviates from its
 * own convention in 10 paragraphs out of 1445 (0.7%), Morphotrophic in 328 out
 * of 1792 (18%) — including 25 that kept the English “ outright. So the count
 * does not merely name the convention, it separates a consistent book from an
 * inconsistent one.
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
 * The convention a text follows, and what competes with it.
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
 * Which chunks depart from the book's own convention.
 *
 * Only a marker that competes across the whole book counts as a departure. The
 * looser rule — any marker out-numbering the book's inside one chunk — reads
 * ordinary typography as dialogue: it flagged a chunk of Ryuker for seventeen
 * lines of `*`, which is a bolded FAQ, and a chunk of Overtime for four, which
 * is a poem in italics. A second convention worth reporting shows up book-wide;
 * `book.rivals` is exactly that test, already applied.
 *
 * Chunks with no marked lines are not deviations — narration without dialogue
 * is not a punctuation choice.
 *
 * @param {Array<{translation?: string, original?: string}>} chunks
 * @param {{marker: string, rivals: Array<{marker: string}>}} book  from dominantMarker
 * @param {'translation'|'original'} field
 * @returns {Array<{i: number, marker: string, count: number, own: number, sample: string|null}>}
 */
export function deviatingChunks(chunks, book, field = 'translation') {
    const marker = book?.marker;
    if (!marker) return [];
    const competing = new Set((book.rivals || []).map(r => r.marker));
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

/**
 * Everything the passport needs about dialogue, measured from a text.
 *
 * @returns {{marker: string, sample: string|null, counts: object, source: 'measured'}|null}
 */
export function measureDialogue(text) {
    const found = dominantMarker(text);
    if (!found.marker) return null;
    return {
        marker: found.marker,
        sample: sampleLine(text, found.marker),
        // Kept so the interface can show "— 1464, « 303, “ 25" rather than a
        // bare verdict: the counts are the argument for the verdict, and a
        // person overruling it should see what they are overruling.
        counts: Object.fromEntries(found.tally.slice(0, 6)),
        source: 'measured',
    };
}
