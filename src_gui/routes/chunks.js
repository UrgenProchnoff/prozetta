/** One chunk and its past: reading, hand edits, search and replace, history and undo. */
import fs from 'fs';
import { jobManager } from '../jobs.js';
import { withoutTranslation } from '../../src_v4/core/state_manager.js';
import { wholeWordRegex } from '../../src_v4/core/text_stats.js';
import { countTokens } from '../../src_v4/core/tokenizer.js';
import { outstandingFindings as reviewOutstanding } from '../../src_v4/core/translation_review.js';
import { locateQuote } from '../../src_v4/core/quoted_spans.js';
import { wordDiff, condense, diffSize } from '../../src_v4/core/text_diff.js';
import { app } from '../app.js';
import { statePath, transReviewPath, readJson, writeJsonAtomic, validPrefix, passageWithBreaks } from '../helpers.js';

// --- API: chunks ---

app.get('/api/projects/:prefix/chunks/:i', (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    const state = readJson(statePath(prefix));
    const i = parseInt(req.params.i, 10);
    const chunk = state.chunks?.[i];
    if (!chunk) return res.status(404).json({ error: 'Chunk not found' });
    res.json({ i, total: state.chunks.length, chunk, findings: chunkFindings(prefix, state.chunks, i) });
});

/**
 * What the whole-book review has to say about one chunk, with each quote's place
 * in the translation.
 *
 * The review list could send a reader to the right chunk and no further: four
 * thousand characters, and somewhere in them the sentence being complained
 * about. The offsets come from the same locateQuote the findings were verified
 * with, so a quote that is here at all is here exactly where it was found.
 *
 * Only the findings still outstanding — one already dealt with is not something
 * to go looking for, and a dismissed one is a judgement the reader has already
 * made.
 */
function chunkFindings(prefix, chunks, i) {
    if (!fs.existsSync(transReviewPath(prefix))) return [];
    try {
        const { open } = reviewOutstanding(readJson(transReviewPath(prefix)), chunks);
        const text = chunks[i]?.translation || '';
        return open.filter(f => f.chunk === i).map(f => {
            const { offset, end, occurrences } = locateQuote(text, f.quote);
            const inText = passageWithBreaks(text, f);
            return {
                key: f.key, scope: f.scope, issue: f.issue, quote: f.quote,
                ...(inText ? { inText } : {}),
                problem: f.problem, advice: f.advice, queued: !!f.queued,
                // Absent when the quote cannot be pointed at: a fix may have
                // changed the words while leaving the finding open, and offering
                // to jump to a place that is no longer there is worse than not
                // offering. The finding still shows — it is still outstanding.
                ...(occurrences === 1 ? { start: offset, end } : {}),
            };
        });
    } catch { return []; }
}

/**
 * Find a string in every chunk at once.
 *
 * The editor could show one chunk and the glossary could count a term, and
 * between them there was no way to ask the plain question a translator asks all
 * day: where else does this occur, and what did I do with it there. The chunk
 * page is where it belongs, because the answer is always followed by going and
 * looking.
 *
 * Whole-word matching goes through wholeWordRegex, which drops the boundary on
 * the side facing an unspaced script — a \b would find one occurrence in five of
 * a Han name, and the search would quietly lie about a whole book.
 *
 * Hits are capped. A two-letter word matches tens of thousands of times, and the
 * useful part of that answer is the count, which is reported in full either way.
 */
app.get('/api/projects/:prefix/search', (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    const needle = String(req.query.q || '');
    if (needle.length < 2) return res.json({ hits: [], total: 0, chunks: 0, capped: false });

    const field = ['translation', 'original', 'both'].includes(req.query.field) ? req.query.field : 'translation';
    const fields = field === 'both' ? ['original', 'translation'] : [field];
    const whole = req.query.whole === '1';
    const sensitive = req.query.case === '1';
    const re = searchRegex(needle, { whole, sensitive });

    const CAP = 300, PAD = 60;
    const chunks = readJson(statePath(prefix)).chunks || [];
    const hits = [];
    let total = 0;
    const touched = new Set();

    chunks.forEach((chunk, i) => {
        for (const f of fields) {
            const text = chunk?.[f];
            if (!text) continue;
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(text)) !== null) {
                // A pattern that can match nothing would spin here forever.
                if (m[0] === '') { re.lastIndex++; continue; }
                total++;
                touched.add(i);
                if (hits.length < CAP) {
                    hits.push({
                        chunk: i, field: f, start: m.index, end: m.index + m[0].length,
                        before: text.slice(Math.max(0, m.index - PAD), m.index).replace(/\s+/g, ' '),
                        match: m[0],
                        after: text.slice(m.index + m[0].length, m.index + m[0].length + PAD).replace(/\s+/g, ' '),
                    });
                }
            }
        }
    });

    res.json({ hits, total, chunks: touched.size, capped: total > hits.length });
});

/** The regex a search or a replace runs, built once so both agree. */
function searchRegex(needle, { whole, sensitive }) {
    const flags = sensitive ? 'gu' : 'giu';
    return whole
        ? wholeWordRegex(needle, flags)
        : new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
}

/**
 * Replace across the book, or at one place in it.
 *
 * Only in translations. The original is what everything else is measured
 * against — the review's quotes, the chunk offsets, the fingerprint a whole-book
 * answer is checked with — and editing it would leave all of them describing a
 * book that no longer exists. The search reads it; nothing writes it.
 *
 * Every touched chunk keeps the text it had, under a batch the whole operation
 * shares, so one wrong replace across forty chunks is one undo and not forty
 * repairs. A replace at one named place verifies the place first: the span comes
 * from a search that may be a minute old, and a stale offset would put the new
 * word in the middle of a different sentence.
 */
app.post('/api/projects/:prefix/replace', (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    if (jobManager.isRunning(prefix)) {
        return res.status(409).json({ error: 'Этап выполняется — редактирование заблокировано' });
    }

    const { q, to, whole, at } = req.body || {};
    const needle = String(q || '');
    const replacement = String(to ?? '');
    if (needle.length < 2) return res.status(400).json({ error: 'Nothing to search for.' });

    const file = statePath(prefix);
    const state = readJson(file);
    const chunks = state.chunks || [];
    const re = searchRegex(needle, { whole: !!whole, sensitive: !!req.body.case });
    const batch = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const stamp = new Date().toISOString();
    const touched = [];
    let count = 0;

    const record = (chunk, before, n) => {
        chunk.history = chunk.history || [];
        chunk.history.push({
            step: 'replace', text: chunk.translation, before,
            replaced: { from: needle, to: replacement, n }, batch, timestamp: stamp,
        });
        // The budget guard for whole-book calls reads this, and a replace can
        // move it by thousands of tokens across a book.
        chunk.translationTokens = countTokens(chunk.translation);
    };

    if (at && Number.isInteger(at.chunk)) {
        const chunk = chunks[at.chunk];
        const text = chunk?.translation;
        if (!text) return res.status(404).json({ error: 'Chunk not found.' });
        const found = text.slice(at.start, at.end);
        // Compared the way the search matched it, so "Pat" can be replaced from a
        // case-insensitive search without the check calling it a different word.
        const same = req.body.case ? found === needle : found.toLowerCase() === needle.toLowerCase();
        if (!same) {
            return res.status(409).json({
                error: `The text at that place now reads "${found.slice(0, 40)}" and not "${needle}". ` +
                    `Search again — the chunk has changed since these results were found.`,
            });
        }
        const before = text;
        chunk.translation = text.slice(0, at.start) + replacement + text.slice(at.end);
        record(chunk, before, 1);
        touched.push(at.chunk);
        count = 1;
    } else {
        chunks.forEach((chunk, i) => {
            const text = chunk?.translation;
            if (!text) return;
            re.lastIndex = 0;
            const n = (text.match(re) || []).length;
            if (!n) return;
            chunk.translation = text.replace(re, () => replacement);
            record(chunk, text, n);
            touched.push(i);
            count += n;
        });
    }

    if (!count) return res.json({ ok: true, chunks: 0, replacements: 0, batch: null });

    state.metadata = state.metadata || {};
    state.metadata.updatedAt = stamp;
    writeJsonAtomic(file, state);
    res.json({ ok: true, chunks: touched.length, replacements: count, batch, at: touched });
});

/**
 * Take back one recorded change, or a whole batch of them.
 *
 * Always by appending. A page whose job is to show what happened cannot have a
 * way of making things un-happen, and an undo that is itself in the list is an
 * undo that can be undone in its turn.
 *
 * Each undo gets a batch of its own rather than borrowing the one it reverses.
 * They looked interchangeable — the same four chunks, the same one action — and
 * sharing the id meant an undo asked to reverse itself went looking for the
 * replace instead and found it already dealt with. An action's identity is the
 * action, not the text it happens to be about.
 */
function revertStep(chunk, at, batch, stamp) {
    const step = chunk?.history?.[at];
    if (!step || step.text === undefined) return { error: 'No such change.' };

    let before = step.before;
    if (before === undefined) {
        before = null;
        for (let k = at - 1; k >= 0; k--) {
            if (chunk.history[k]?.text !== undefined) { before = chunk.history[k].text; break; }
        }
    }
    if (before === null) return { error: 'first' };

    chunk.translation = before;
    chunk.translationTokens = countTokens(before);
    chunk.history.push({
        step: 'revert', text: before, before: step.text,
        undid: { step: step.step, at: step.timestamp },
        ...(batch ? { batch } : {}), timestamp: stamp,
    });
    return { ok: true };
}

/** The endpoint both the toast's Undo and the history page's use. */
function handleRevert(req, res) {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    if (jobManager.isRunning(prefix)) {
        return res.status(409).json({ error: 'Этап выполняется — редактирование заблокировано' });
    }
    const file = statePath(prefix);
    const state = readJson(file);
    const stamp = new Date().toISOString();
    const batch = String(req.body?.batch || '');
    const mine = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let done = 0;

    if (batch) {
        for (const chunk of state.chunks || []) {
            // The last entry carrying that batch, so a batch already reverted and
            // reverted again walks forward rather than back.
            let at = -1;
            (chunk.history || []).forEach((h, k) => { if (h?.batch === batch) at = k; });
            if (at < 0) continue;
            // Already taken back: its own undo carries a batch that says so.
            if ((chunk.history || []).some(h => h.step === 'revert' && h.undidBatch === batch)) continue;
            if (revertStep(chunk, at, mine, stamp).ok) {
                chunk.history[chunk.history.length - 1].undidBatch = batch;
                done++;
            }
        }
        if (!done) return res.status(404).json({ error: 'That change is no longer on record, or is already taken back.' });
    } else {
        const i = parseInt(req.body?.chunk, 10);
        const at = parseInt(req.body?.at, 10);
        const chunk = state.chunks?.[i];
        const r = revertStep(chunk, at, null, stamp);
        if (r.error === 'first') {
            return res.status(409).json({
                error: `That is the first version of chunk ${i + 1} — there is nothing behind it to go back to. ` +
                    `Use "reset the chunk" to leave it untranslated.`,
            });
        }
        if (r.error) return res.status(404).json({ error: r.error });
        done = 1;
    }

    state.metadata = state.metadata || {};
    state.metadata.updatedAt = stamp;
    writeJsonAtomic(file, state);
    res.json({ ok: true, chunks: done });
}

app.post('/api/projects/:prefix/replace/undo', handleRevert);

app.put('/api/projects/:prefix/chunks/:i', (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    if (jobManager.isRunning(prefix)) {
        return res.status(409).json({ error: 'Этап выполняется — редактирование заблокировано' });
    }

    const file = statePath(prefix);
    const state = readJson(file);
    const i = parseInt(req.params.i, 10);
    const chunk = state.chunks?.[i];
    if (!chunk) return res.status(404).json({ error: 'Chunk not found' });

    const { translation, translation_status, reset } = req.body || {};

    if (reset) {
        // The same deny-list the whole-project reset uses. This used to delete
        // five fields by hand and leave `advice` and `dispute` behind: the map
        // then showed an untranslated chunk marked as a quarrel whose history
        // had just been erased, and the next run judged a fresh draft — made
        // without the advice — against a must_fix written about the wording of
        // the text that was deleted, with redrafting switched off because advice
        // was queued. The page warns first when there is advice to lose.
        state.chunks[i] = withoutTranslation(chunk);
    } else {
        if (typeof translation === 'string') {
            chunk.translation = translation;
            // Counted here for the same reason a replace counts: the whole-book
            // budget guard reads this, and an edit can move it either way.
            chunk.translationTokens = countTokens(translation);
        }
        if (typeof translation_status === 'string') chunk.translation_status = translation_status;
        // Approved by a person, which settles what the marks were waiting for —
        // the same three the translation loop clears when its reviewer approves.
        // Left in place, a dispute would outlive the human decision it asked for,
        // and queued advice would send the next run to "fix" a text somebody has
        // just accepted. A finding whose quote the edit left alone returns to the
        // open list, undecided rather than silently queued.
        if (translation_status === 'success') {
            delete chunk.dispute;
            delete chunk.advice;
            delete chunk.translation_blocked_by;
        }
        chunk.history = chunk.history || [];
        chunk.history.push({
            step: 'manual_edit',
            text: chunk.translation,
            timestamp: new Date().toISOString()
        });
    }

    state.metadata = state.metadata || {};
    state.metadata.updatedAt = new Date().toISOString();
    writeJsonAtomic(file, state);
    res.json({ ok: true });
});

// --- API: history ---
// Everything that has changed a chunk's text, in one list. The chunk pages have
// held this all along, one chunk at a time, which answers "what happened here"
// and never "what happened last night".

/**
 * The entries that actually changed something, newest first.
 *
 * A check is not a change. There are 711 of them across the projects here and
 * they record a score against a text they left alone; listed as changes they
 * would bury the 541 that are changes under twice their number of non-events.
 *
 * Size is reported as a length difference rather than a real diff: the diff of
 * one pair costs up to 26ms, and five hundred of them would be a quarter-minute
 * spent to fill a column. The diff is computed when a row is opened.
 */
function historyRows(chunks) {
    const rows = [];
    (chunks || []).forEach((chunk, index) => {
        let previous = null;
        (chunk.history || []).forEach((step, at) => {
            if (step?.text === undefined) return;
            const before = step.before !== undefined ? step.before : previous;
            previous = step.text;
            if (before === null || before === step.text) return;
            rows.push({
                chunk: index, at, step: step.step, timestamp: step.timestamp || null,
                chars: step.text.length - before.length,
                batch: step.batch || null,
                replaced: step.replaced || null,
                undid: step.undid || null,
            });
        });
    });
    rows.sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')) || b.chunk - a.chunk);
    return rows;
}

/** One action, however many chunks it touched: a replace is undone as a whole. */
function groupRows(rows) {
    const out = [];
    const byBatch = new Map();
    for (const row of rows) {
        // Each chunk keeps its own place in its own history: a batch that knew
        // only the first would offer a preview of one chunk while claiming four.
        const where = { chunk: row.chunk, at: row.at };
        if (!row.batch) { out.push({ ...row, chunks: [where] }); continue; }
        const key = `${row.step}:${row.batch}`;
        if (!byBatch.has(key)) {
            const group = { ...row, chunks: [], chars: 0 };
            byBatch.set(key, group);
            out.push(group);
        }
        const group = byBatch.get(key);
        group.chunks.push(where);
        group.chars += row.chars;
    }
    return out;
}

/** A step's kind, without the attempt number the translation loop appends. */
const stepKind = (step) => String(step || '').replace(/_\d+$/, '');

app.get('/api/projects/:prefix/history', (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    const chunks = readJson(statePath(prefix)).chunks || [];
    const all = groupRows(historyRows(chunks));

    // Counted over every row, not the filtered ones: a filter whose numbers move
    // when you use it cannot be read, and the point of the number is to say what
    // is there before you ask for it.
    const kinds = {};
    for (const row of all) {
        const kind = stepKind(row.step);
        kinds[kind] = (kinds[kind] || 0) + 1;
    }

    const wanted = String(req.query.kind || '').split(',').map(k => k.trim()).filter(Boolean);
    const rows = wanted.length ? all.filter(row => wanted.includes(stepKind(row.step))) : all;

    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 60));
    res.json({ total: rows.length, all: all.length, kinds, offset, rows: rows.slice(offset, offset + limit) });
});

app.get('/api/projects/:prefix/history/diff', (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    const chunks = readJson(statePath(prefix)).chunks || [];
    const i = parseInt(req.query.chunk, 10);
    const at = parseInt(req.query.at, 10);
    const history = chunks[i]?.history || [];
    const step = history[at];
    if (!step || step.text === undefined) return res.status(404).json({ error: 'No such change.' });

    let before = step.before;
    if (before === undefined) {
        before = null;
        for (let k = at - 1; k >= 0; k--) {
            if (history[k]?.text !== undefined) { before = history[k].text; break; }
        }
    }
    if (before === null) return res.json({ first: true, runs: [{ op: 'ins', text: step.text }] });
    res.json({ runs: condense(wordDiff(before, step.text)), size: diffSize(wordDiff(before, step.text)) });
});

app.post('/api/projects/:prefix/history/revert', handleRevert);
