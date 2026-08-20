/**
 * Carrying Stage 1's work across a re-split.
 *
 * The passport stage may re-cut a book so that no chunk straddles a change of
 * narrator. The splitter returns bare chunks — text and a token count — so a
 * re-split used to throw away `extracted_terms`, the per-chunk result of Stage 1.
 * The glossary file survives (it lives apart), but the extraction behind it does
 * not, and rebuilding it means paying for every extraction call again.
 *
 * Nothing needs to be asked of a model to avoid that. Old and new chunks are
 * consecutive slices of the same string, so both lie on one axis of character
 * offsets; a term's place can be computed rather than stored.
 *
 * The axis has to reconstruct exactly, which is checked rather than assumed. It
 * did not, until recently: the splitter appended a newline the source never had,
 * and every offset past it would have been wrong by one.
 */

import { wholeWordRegex } from './text_stats.js';

/** Half-open [start, end) character range of every chunk, on the shared axis. */
function spans(chunks) {
    let at = 0;
    return chunks.map(c => {
        const start = at;
        at += (c.original || '').length;
        return [start, at];
    });
}

/** Which chunk covers a character position. */
function chunkAt(ranges, position) {
    let lo = 0, hi = ranges.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (position < ranges[mid][0]) hi = mid - 1;
        else if (position >= ranges[mid][1]) lo = mid + 1;
        else return mid;
    }
    return -1;
}

/** Indices of every chunk overlapping [start, end). */
function overlapping(ranges, start, end) {
    const out = [];
    for (let i = 0; i < ranges.length; i++) {
        if (ranges[i][0] < end && ranges[i][1] > start) out.push(i);
    }
    return out;
}

// The same key Stage 1b consolidates by, so a term merged here and a term merged
// there are the same term.
const key = (term) => String(term?.original || '').trim().toLowerCase();

/**
 * Move extracted terms from one chunking of a text to another.
 *
 * Each term is pinned by finding its own text inside the chunk it was recorded
 * against — not across the whole book, since the record means "the model saw
 * this here" and widening the search would change what the data says. Matching
 * goes through wholeWordRegex, which knows that a boundary cannot be required in
 * Chinese, Japanese, Korean or Thai.
 *
 * A term whose text cannot be found where it was recorded is not dropped: the
 * model normalises what it reports, writing "Sue Smith" for a passage that says
 * "Sue". Those fall back to every new chunk overlapping the old one. A term in
 * one chunk too many is noise in a cheat sheet; a term lost is a hole in the
 * glossary, and the two costs are not comparable.
 *
 * @param {Array} oldChunks  chunks carrying extracted_terms / extraction_status
 * @param {Array} newChunks  fresh chunks from the splitter
 * @returns {{chunks: Array, stats: object, refused: string|null}}
 *   `refused` is a reason string when the two chunkings do not describe the same
 *   text; nothing is carried in that case.
 */
export function carryExtraction(oldChunks, newChunks) {
    const stats = { terms: 0, located: 0, fallback: 0, placements: 0, extracted: 0 };
    const chunks = newChunks.map(c => ({ ...c }));

    const before = (oldChunks || []).map(c => c.original || '').join('');
    const after = chunks.map(c => c.original || '').join('');
    if (before !== after) {
        return {
            chunks: newChunks,
            stats,
            refused: `the two chunkings describe different text (${before.length} characters against ${after.length}), `
                + 'so character offsets do not line up and every term would be attributed by guesswork',
        };
    }

    const oldSpans = spans(oldChunks);
    const newSpans = spans(chunks);
    const buckets = chunks.map(() => new Map());

    oldChunks.forEach((chunk, i) => {
        const [start, end] = oldSpans[i];
        const text = chunk.original || '';
        for (const term of chunk.extracted_terms || []) {
            if (!key(term)) continue;
            stats.terms++;

            const targets = new Set();
            let match;
            const re = wholeWordRegex(term.original, 'giu');
            while ((match = re.exec(text)) !== null) {
                const at = chunkAt(newSpans, start + match.index);
                if (at >= 0) targets.add(at);
                if (match.index === re.lastIndex) re.lastIndex++;   // zero-width guard
            }

            if (targets.size) stats.located++;
            else {
                stats.fallback++;
                for (const at of overlapping(newSpans, start, end)) targets.add(at);
            }

            for (const at of targets) {
                if (!buckets[at].has(key(term))) {
                    buckets[at].set(key(term), term);
                    stats.placements++;
                }
            }
        }
    });

    chunks.forEach((chunk, i) => {
        const terms = [...buckets[i].values()];
        if (terms.length) chunk.extracted_terms = terms;

        // Extracted only if everything underneath it was. The other way round
        // would silently claim work that was never done, and Stage 1 would skip
        // a chunk whose terms nobody ever collected — a re-run costs calls, a
        // false "done" costs terms.
        const covering = overlapping(oldSpans, newSpans[i][0], newSpans[i][1]);
        if (covering.length && covering.every(j => oldChunks[j].extraction_status === 'success')) {
            chunk.extraction_status = 'success';
            stats.extracted++;
        }
    });

    return { chunks, stats, refused: null };
}
