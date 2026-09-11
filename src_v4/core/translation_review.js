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
 * @param {Array} glossary   the glossary, for checking the entry a finding names
 * @returns {{findings: Array, rejected: object, rejectedFindings: Array}}
 */
export function verifyFindings(raw, chunks, glossary = []) {
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

        // Which glossary entry a glossary finding is about. Checked against the
        // glossary rather than taken on trust, and a finding that names none is
        // kept without one: it is still a true thing about the book, and losing
        // it over a missing field would be the contract eating what it exists to
        // protect. Without a term the chunks it affects cannot be offered, and
        // that is the whole cost.
        let term = null;
        if (scope === 'glossary') {
            const named = String(item.term || '').trim();
            if (named && glossary.some(t => String(t?.original || '').trim().toLowerCase() === named.toLowerCase())) {
                term = named;
            }
        }

        findings.push({
            scope,
            chunk: hits[0],
            issue: String(item.issue || '').trim().slice(0, 40) || 'other',
            problem: String(item.problem || '').trim().slice(0, 400),
            advice: advice.slice(0, 400) || null,
            ...(term ? { term } : {}),
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
 * Was this finding among those a fix was made for?
 *
 * Keys are the record, written by the fix itself. Older steps predate them, so
 * the advice text is matched too — a fix stores the combined instruction it was
 * given, and a finding whose own advice is inside it was part of that fix.
 *
 * Only fixes made after `since` count, and that is what makes a second round
 * possible. A book can be reviewed and fixed five or ten times, and a fix
 * carries the key of the finding it answered forever after. Without the date, a
 * defect that survived its fix would be silently closed by that record every
 * time a later review raised it again — measured on Ryuker, a second review of
 * the same text would have hidden three findings the model had just re-read the
 * text and re-raised, their quotes still in place. The fix demonstrably did not
 * remove what was complained about, and its own receipt was what buried the
 * complaint. A fix answers the review it came after and no later one.
 *
 * A step with no timestamp is not counted. It cannot be placed against the
 * review, and between showing a finding that was dealt with and hiding one that
 * was not, only the second loses anything.
 */
function appliedInHistory(chunk, key, advice, since) {
    const text = String(advice || '').trim();
    const after = since ? Date.parse(since) : NaN;
    for (const step of chunk?.history || []) {
        if (step?.step !== 'advice_fix') continue;
        if (Number.isFinite(after)) {
            const at = Date.parse(step.timestamp || '');
            if (!Number.isFinite(at) || at < after) continue;
        }
        if (Array.isArray(step.keys) && step.keys.includes(key)) return true;
        if (text && String(step.advice || '').includes(text)) return true;
    }
    return false;
}

/**
 * The findings still worth showing, resolved against the translation as it is.
 *
 * A finding answers for itself: its quote is looked for again, and one whose
 * quote has gone was acted on — the chunk was fixed and the text it complained
 * about is no longer there. Nothing has to be marked done by hand, and nothing
 * has to be discarded wholesale when one chunk changes.
 *
 * Dismissals come back alongside the count, because a dismissal is a judgement
 * and a judgement can be wrong: the list is what makes it reversible.
 *
 * @returns {{open: Array, done: number, hidden: number, dismissed: Array}}
 */
export function outstandingFindings(review, chunks) {
    const dismissed = new Set((review?.dismissed || []).map(k => String(k).toLowerCase()));
    // Findings a person says they have dealt with, kept apart from the ones they
    // say are wrong. The dismissal list is evidence about how far an unverified
    // finding can be trusted — the same question rejectedFindings exists to
    // answer — and folding "I did this" into it would spoil the only record that
    // can answer it. A glossary or passport finding has no other way to close:
    // nothing it asks for shows up in the text it quoted.
    const handled = new Set((review?.handled || []).map(k => String(k).toLowerCase()));
    const open = [];
    const dismissedList = [];
    let done = 0, hidden = 0;

    for (const f of review?.findings || []) {
        const key = findingKey(f);
        const chunk = chunks[f.chunk];
        const text = chunk?.translation;

        // Still queued on its chunk: accepted, waiting for the next run — and
        // that outranks every way a finding can be closed. A closed finding whose
        // advice is still queued used to vanish from the screen while the advice
        // stayed on the chunk: the corner was marked, the next run would act on
        // it, and there was nothing anywhere to take it back out. "Queue the
        // chunks using this term" reaches that state by design, since it marks
        // the finding done the moment it queues the work.
        const queued = (chunk?.advice || []).some(a => a.key === key);
        if (!queued) {
            if (dismissed.has(key)) { hidden++; dismissedList.push({ ...f, key }); continue; }
            if (handled.has(key)) { done++; continue; }
            if (!text) { done++; continue; }
        }

        // Acted on. Two ways of knowing, because the obvious one is not enough:
        // a finding whose quote has gone was clearly fixed, but a fix can leave
        // the quote untouched — typography changes the marks around the words and
        // not the words — and such a finding used to reappear looking undecided
        // after it had been done. So the history is asked as well: a fix records
        // which findings it was for, and one that has been applied and approved
        // (queued no longer, since approval clears it) is finished whatever the
        // text now reads like.
        if (!queued && appliedInHistory(chunk, key, f.advice, review?.generatedAt)) { done++; continue; }
        if (!queued && locateQuote(text, f.quote).occurrences === 0) { done++; continue; }

        open.push({ ...f, key, queued });
    }

    // By chunk, so findings that will be fixed together are read together and the
    // order matches the map above the list. Within a chunk, queued last: what is
    // still to decide belongs at the top of its group.
    open.sort((a, b) => (a.chunk - b.chunk)
        || (Number(a.queued) - Number(b.queued))
        || String(a.issue).localeCompare(String(b.issue)));
    dismissedList.sort((a, b) => (a.chunk - b.chunk) || String(a.issue).localeCompare(String(b.issue)));

    return { open, done, hidden, dismissed: dismissedList };
}

/**
 * Everything queued for the next translation run, chunk by chunk.
 *
 * Read from the chunks rather than from the review, because advice outlives the
 * review that produced it: a second review writes a new set of findings, and the
 * advice accepted from the first one stays on its chunks with nothing left to
 * point at. That queue is work the next run will do, so it has to be visible and
 * removable on its own terms.
 *
 * @returns {Array<{chunk: number, items: Array<object>}>}
 */
export function adviceQueue(chunks) {
    const out = [];
    (chunks || []).forEach((chunk, i) => {
        const items = chunk?.advice || [];
        if (items.length) out.push({ chunk: i, items });
    });
    return out;
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
