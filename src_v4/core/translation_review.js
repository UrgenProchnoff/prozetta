/**
 * Reviewing a finished translation, and turning what comes back into work.
 *
 * The chunk-by-chunk reviewer approves nearly everything: measured across five
 * finished books its score has a median of 10 and a minimum of 9. That is not a
 * broken reviewer — it is a correct one answering about four thousand characters
 * at a time. A flattened joke, a calque, a register that drifts between chapters:
 * none of them are visible from inside the chunk where they happen.
 *
 * So a second pass reads the whole translation at once. It is given the
 * translation and a stripped glossary, not the original: measured, Morphotrophic
 * comes to 193,400 tokens that way against a 250,000 budget, while adding the
 * original would put Ryuker at 286,214 and over. The original is not needed
 * here anyway — it is already in front of the model that does the fixing.
 *
 * Two things this module insists on, both bought with experience.
 *
 * The finding must quote the translation, and the code decides which chunk that
 * is. Asked by hand, this same review of this same book was right about all
 * fifteen problems it reported and wrong about where they were — it placed one
 * occurrence in two chapters and named a chapter off by one. The substance
 * survives verification; the address does not, so the address is computed.
 *
 * And a finding declares its scope. The same report mixed «забива» for «забоя»,
 * which one chunk can fix, with "unify the terminology across the book", which
 * no chunk can. Sending the second into a chunk's fix prompt asks a fragment to
 * repair the whole; those belong to the glossary and the passport instead.
 */

import { locateQuote } from './quoted_spans.js';

/** Where a finding has to be acted on. */
const SCOPES = new Set(['chunk', 'glossary', 'passport']);

/**
 * Find a quote in the translation as one text, and say which chunk it begins in.
 *
 * The joined text has to be built the same way the prompt builds it, or offsets
 * mean nothing: one newline between chunks, in order.
 *
 * @returns {{chunk: number, occurrences: number}} chunk -1 when not found
 */
function locateInJoined(chunks, quote) {
    const bounds = [];
    let at = 0;
    const parts = [];
    for (const c of chunks) {
        const text = c?.translation || '';
        bounds.push([at, at + text.length]);
        parts.push(text);
        at += text.length + 1;   // the '\n' the join inserts
    }
    const found = locateQuote(parts.join('\n'), quote);
    if (found.occurrences === 0) return { chunk: -1, occurrences: 0 };
    const index = bounds.findIndex(([from, to]) => found.offset >= from && found.offset < to);
    return { chunk: index, occurrences: found.occurrences };
}

/**
 * Check every finding before anyone sees it.
 *
 * Survives only if it names a scope we implement, quotes the translation, that
 * quote occurs in exactly one chunk, and — when it asks for a chunk to be fixed
 * — it says what the translator should have been told. A partly invented answer
 * degrades to fewer findings rather than to wrong ones.
 *
 * @param {Array} raw        findings as parsed from the model
 * @param {Array} chunks     project chunks, carrying `translation`
 * @returns {{findings: Array, rejected: object, rejectedFindings: Array}}
 */
export function verifyFindings(raw, chunks) {
    const rejected = {
        malformed: 0,        // not an object, or a scope we do not implement
        badQuote: 0,         // the quote is in no chunk's translation
        ambiguousQuote: 0,   // the quote is in more than one chunk
        noAdvice: 0,         // asks for a fix without saying what to do
    };
    const rejectedFindings = [];
    // Kept as written, trimmed only for length: what the model actually said is
    // the evidence, and normalising it away would defeat the point of keeping it.
    const drop = (reason, item) => {
        rejected[reason]++;
        rejectedFindings.push({
            reason,
            scope: String(item?.scope || '').slice(0, 20),
            issue: String(item?.issue || '').slice(0, 40),
            quote: String(item?.quote || '').slice(0, 400),
            problem: String(item?.problem || '').slice(0, 400),
            advice: String(item?.advice || '').slice(0, 400),
        });
    };

    if (!Array.isArray(raw)) return { findings: [], rejected, rejectedFindings };

    const findings = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') { drop('malformed', item); continue; }

        const scope = String(item.scope || 'chunk').trim().toLowerCase();
        if (!SCOPES.has(scope)) { drop('malformed', item); continue; }

        const quote = String(item.quote || '').trim();
        const advice = String(item.advice || '').trim();
        if (scope === 'chunk' && !advice) { drop('noAdvice', item); continue; }

        // Which chunk, decided here rather than taken from the answer. Every
        // chunk is searched so that a quote in none of them, or in two, is
        // caught instead of being attributed to whichever one was claimed.
        const hits = [];
        for (let i = 0; i < chunks.length && hits.length < 2; i++) {
            const text = chunks[i]?.translation;
            if (!text) continue;
            if (locateQuote(text, quote).occurrences > 0) hits.push(i);
        }
        // A quote can straddle a boundary the reviewer never saw: the
        // translation-only prompt is one seamless text, so nothing tells it where
        // chunk 12 ends. Measured on Morphotrophic, that is exactly what happened
        // to the untranslated "Chapter 4" — the heading closes one chunk and the
        // sentence quoted after it opens the next, and searching chunk by chunk
        // found it in neither. The text is in the book; only the address needed
        // work, so it is looked up on the joined text and attributed to the chunk
        // it starts in.
        if (!hits.length) {
            const at = locateInJoined(chunks, quote);
            if (at.chunk >= 0) hits.push(at.chunk);
            if (at.occurrences > 1) hits.push(at.chunk);   // ambiguous, and said so below
        }
        if (!hits.length) { drop('badQuote', item); continue; }
        // Uniqueness is required only where the chunk decides what gets fixed. A
        // glossary or passport finding is about something that recurs by nature —
        // a term used throughout, a convention held throughout — and its quote is
        // an illustration, not an address. Demanding one occurrence there would
        // throw away exactly the findings that are most certainly true.
        if (scope === 'chunk' && hits.length > 1) { drop('ambiguousQuote', item); continue; }

        findings.push({
            scope,
            chunk: hits[0],
            issue: String(item.issue || '').trim().slice(0, 40) || 'other',
            problem: String(item.problem || '').trim().slice(0, 400),
            advice: advice.slice(0, 400) || null,
            quote,
        });
    }

    return { findings, rejected, rejectedFindings };
}

/**
 * A stable name for a finding, so a decision about it survives a re-run.
 *
 * Made of what the finding is about — its scope, what it objects to, and the
 * text it objects to — never of where it sat. A model that repeats itself stays
 * dismissed; a chunk renumbered by a re-split does not resurrect a judgement
 * somebody already made.
 */
export function findingKey(f) {
    return [f.scope, f.issue, String(f.quote || '').slice(0, 120)].join('|').toLowerCase();
}

/**
 * The findings still worth showing, resolved against the translation as it is.
 *
 * A finding answers for itself: its quote is looked for again, and one whose
 * quote has gone was acted on — the chunk was fixed and the text it complained
 * about is no longer there. Nothing has to be marked done by hand, and nothing
 * has to be discarded wholesale when one chunk changes.
 *
 * @returns {{open: Array, done: number, hidden: number}}
 */
export function outstandingFindings(review, chunks) {
    const dismissed = new Set((review?.dismissed || []).map(k => String(k).toLowerCase()));
    const open = [];
    let done = 0, hidden = 0;

    for (const f of review?.findings || []) {
        const key = findingKey(f);
        if (dismissed.has(key)) { hidden++; continue; }

        const chunk = chunks[f.chunk];
        const text = chunk?.translation;
        if (!text || locateQuote(text, f.quote).occurrences === 0) { done++; continue; }

        // Already queued on its chunk. Accepting one does not make it disappear —
        // it stays until the fix is made and its quote is gone — so without this
        // the list gives no way to tell what has been decided from what has not.
        const queued = (chunk.advice || []).some(a => a.key === key);
        open.push({ ...f, key, queued });
    }

    // By chunk, so findings that will be fixed together are read together and the
    // order matches the map above the list. Within a chunk, queued last: what is
    // still to decide belongs at the top of its group.
    open.sort((a, b) => (a.chunk - b.chunk)
        || (Number(a.queued) - Number(b.queued))
        || String(a.issue).localeCompare(String(b.issue)));

    return { open, done, hidden };
}

/**
 * The advice attached to a chunk, as one instruction for the fix prompt.
 *
 * Several findings can land on the same chunk, and they arrive as separate
 * sentences; the fix prompt takes a single comment. Numbered rather than run
 * together so that a fix which addresses two of three is visibly a fix which
 * addressed two of three.
 */
export function adviceForChunk(advice) {
    const items = (advice || []).map(a => String(a?.advice || '').trim()).filter(Boolean);
    if (!items.length) return '';
    if (items.length === 1) return items[0];
    return items.map((text, i) => `${i + 1}. ${text}`).join('\n');
}
