/**
 * Where a passport note starts and stops applying.
 *
 * Some decisions change halfway through a book. In Crystal Society the android
 * speaks of itself in the masculine until it takes the name Crystal and in the
 * feminine after; between two people "вы" becomes "ты" at some scene. A note
 * that says both halves goes to every chunk, and each chunk's translator has to
 * work out which half it is in — from a piece of 4000 characters that usually
 * does not say. So a note may carry a boundary, and the chunk is handed only the
 * half that holds for it.
 *
 * A boundary is a verbatim quote from the ORIGINAL, not a chunk number: a quote
 * survives the book being cut into chunks again, a model that has read the book
 * can name the place but cannot count chunks, and a quote is checkable — it
 * occurs in the text exactly once or it is not a boundary. The chunk it falls in
 * is worked out each time it is needed.
 *
 * `from` — the note holds from the quoted place on, the place included.
 * `until` — the note holds up to the quoted place, the place excluded. One note
 * ending and the next beginning at the same quote split the book cleanly.
 */
import { flatten, locateQuote } from './quoted_spans.js';

/** Non-empty lines of a text, with where each begins and ends. */
function paragraphs(text) {
    const out = [];
    const re = /[^\n]+/g;
    let m;
    while ((m = re.exec(text || ''))) {
        const lead = m[0].length - m[0].trimStart().length;
        const body = m[0].trim();
        if (body) out.push({ start: m.index + lead, end: m.index + lead + body.length, text: body });
    }
    return out;
}

/**
 * The original as one text, prepared for locating quotes in it. Chunks are
 * consecutive slices of the source, so their offsets are the running length.
 */
export function bookText(chunks) {
    const starts = [];
    let text = '';
    for (const c of chunks || []) { starts.push(text.length); text += c?.original || ''; }
    return { text, starts, prepared: flatten(text), chunks: chunks || [] };
}

function chunkAt(book, offset) {
    let lo = 0, hi = book.starts.length - 1, found = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (book.starts[mid] <= offset) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
}

/**
 * Where a quote falls.
 *
 * @returns {{found: true, chunk: number, offset: number, cut: boolean}
 *         | {found: false, ambiguous: boolean}}
 *   `cut` — the place is inside the chunk rather than at its start, so the
 *   chunk holds both sides of the boundary and has to be told where it is.
 */
export function placeQuote(book, quote) {
    const { offset, occurrences } = locateQuote(book.text, quote, book.prepared);
    if (occurrences !== 1) return { found: false, ambiguous: occurrences > 1 };
    const chunk = chunkAt(book, offset);
    return { found: true, chunk, offset, cut: book.text.slice(book.starts[chunk], offset).trim() !== '' };
}

/**
 * Every bounded note with `place`: the first and last chunk it reaches, and
 * where each of its boundaries fell. Notes without a boundary come back as they
 * were. A boundary that cannot be found is left out of the reckoning — the note
 * then reaches as far as it would without it, which is where it was before it
 * had one — and is reported in `place.from`/`place.until` as not found.
 */
export function placeNotes(notes, chunks) {
    if (!(notes || []).some(n => n?.from || n?.until)) return notes || [];
    const book = bookText(chunks);
    const lastChunk = Math.max(0, book.chunks.length - 1);
    return notes.map(n => {
        if (!n?.from && !n?.until) return n;
        const from = n.from ? placeQuote(book, n.from) : null;
        const until = n.until ? placeQuote(book, n.until) : null;
        const first = from?.found ? from.chunk : 0;
        // A place that opens a chunk leaves that chunk wholly outside the note.
        const last = until?.found ? (until.cut ? until.chunk : until.chunk - 1) : lastChunk;
        return { ...n, place: { first, last, from, until } };
    });
}

/**
 * The notes one chunk is to be given, each with the boundary it has to be told
 * about — only where the boundary falls inside this very chunk.
 *
 * @returns {Array<{note: object, from: string|null, until: string|null}>}
 */
export function notesForChunk(notes, index) {
    return (notes || [])
        .filter(n => !n.place || (index >= n.place.first && index <= n.place.last))
        .map(n => ({
            note: n,
            from: n.place?.from?.found && n.place.from.cut && n.place.from.chunk === index ? n.from : null,
            until: n.place?.until?.found && n.place.until.cut && n.place.until.chunk === index ? n.until : null,
        }));
}

/** Trim to a word boundary at no more than `max` characters. */
function cutAt(text, max) {
    if (text.length <= max) return text;
    const cut = text.slice(0, max);
    const space = cut.lastIndexOf(' ');
    return (space > max / 2 ? cut.slice(0, space) : cut).trim();
}

/**
 * The shortest start of the text at `offset` that occurs in the book only
 * there — what a boundary picked by pointing at a line is stored as. Null when
 * even a long one repeats (a line printed twice, word for word).
 */
export function uniqueQuoteAt(book, offset) {
    const rest = book.text.slice(offset, offset + 400).replace(/\s+/g, ' ').trim();
    for (const len of [60, 100, 160, 240]) {
        const quote = cutAt(rest, len);
        if (quote.length < 8) return null;
        const hit = locateQuote(book.text, quote, book.prepared);
        if (hit.occurrences === 1 && hit.offset === offset) return quote;
        if (quote.length === rest.length) break;
    }
    return null;
}

/**
 * The original paragraph a translated line stands for.
 *
 * Paragraphs are translated one for one as a rule, and where the two counts
 * agree the same index is the same paragraph. Where they do not, nothing finer
 * than the chunk is known, and its first paragraph is the honest answer —
 * `approx` says so.
 */
function originalFor(chunk, translatedIndex) {
    const src = paragraphs(chunk?.original);
    const dst = paragraphs(chunk?.translation);
    if (!src.length) return null;
    if (src.length === dst.length && src[translatedIndex]) return { para: src[translatedIndex], approx: false };
    return { para: src[0], approx: translatedIndex !== 0 };
}

/**
 * A boundary quoted from the TRANSLATION, turned into one in the original. A
 * reviewer without the original can only point at the translation; the note is
 * applied to the original, where the boundary has to be.
 *
 * @returns {string|null} the original quote, null when the translated quote is
 *   in no chunk or in more than one
 */
export function boundaryFromTranslation(book, quote) {
    const hits = [];
    book.chunks.forEach((c, i) => {
        const hit = locateQuote(c?.translation || '', quote);
        if (hit.occurrences) hits.push({ chunk: i, offset: hit.offset, occurrences: hit.occurrences });
    });
    if (hits.length !== 1 || hits[0].occurrences !== 1) return null;
    const { chunk, offset } = hits[0];
    const k = Math.max(0, paragraphs(book.chunks[chunk].translation).findIndex(p => offset >= p.start && offset < p.end));
    const target = originalFor(book.chunks[chunk], k);
    return target ? uniqueQuoteAt(book, book.starts[chunk] + target.para.start) : null;
}

/**
 * The translated paragraph a boundary in the original falls in — how the
 * boundary is shown to a reviewer who has only the translation.
 */
export function translationAt(book, place) {
    if (!place?.found) return null;
    const chunk = book.chunks[place.chunk];
    const src = paragraphs(chunk?.original);
    const dst = paragraphs(chunk?.translation);
    if (!dst.length) return null;
    const at = place.offset - book.starts[place.chunk];
    const k = src.findIndex(p => at >= p.start && at < p.end);
    const para = src.length === dst.length && k >= 0 ? dst[k] : dst[0];
    return cutAt(para.text, 120);
}

/**
 * Lines matching a search, in the original or the translation, each with the
 * boundary pointing at it would set. For the passport page, where a person
 * finds the place by what they remember of it — usually the translation.
 *
 * @returns {Array<{chunk: number, side: 'original'|'translation', text: string,
 *                  quote: string, approx: boolean}>}
 */
export function findBoundaries(chunks, query, limit = 30) {
    const q = String(query || '').trim().toLowerCase();
    if (q.length < 3) return [];
    const book = bookText(chunks);
    const out = [];
    const seen = new Set();
    for (const [i, c] of book.chunks.entries()) {
        for (const side of ['original', 'translation']) {
            for (const [k, p] of paragraphs(c?.[side]).entries()) {
                if (!p.text.toLowerCase().includes(q)) continue;
                const target = side === 'original' ? { para: p, approx: false } : originalFor(c, k);
                if (!target) continue;
                const quote = uniqueQuoteAt(book, book.starts[i] + target.para.start);
                if (!quote || seen.has(`${side}\0${quote}`)) continue;
                seen.add(`${side}\0${quote}`);
                out.push({ chunk: i, side, text: cutAt(p.text, 200), quote, approx: target.approx });
                if (out.length >= limit) return out;
            }
        }
    }
    return out;
}
