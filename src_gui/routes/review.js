/** Decisions on the whole-book translation review, and advice queued on chunks by hand. */
import fs from 'fs';
import { jobManager } from '../jobs.js';
import { findingKey } from '../../src_v4/core/translation_review.js';
import { findingKey as glossaryFindingKey } from '../../src_v4/core/glossary_review.js';
import { manualKey, parseChunkList, chunksContaining } from '../../src_v4/core/manual_advice.js';
import { app } from '../app.js';
import { statePath, transReviewPath, reviewPath, passportPath, readJson, readGlossaryOrEmpty, writeJsonAtomic, validPrefix, chunksUsingTerm } from '../helpers.js';

/**
 * Decide a finding from the whole-book review.
 *
 * "accept" queues the advice on the chunk the quote was found in; the next
 * translation run fixes that chunk with the advice as its instruction and clears it
 * on approval. "dismiss" records the judgement by findingKey, which survives a
 * re-review — a finding argued down once should not have to be argued down again
 * because the pass was repeated.
 *
 * Only chunk-scoped findings can be accepted. A glossary or passport finding
 * names something one chunk cannot repair, and queueing it as chunk advice would
 * ask a fragment to unify a book.
 */
app.post('/api/projects/:prefix/translation-review/decide', (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    if (jobManager.isRunning(prefix)) {
        return res.status(409).json({ error: 'Этап выполняется — решения заблокированы' });
    }
    const { key, action } = req.body || {};
    if (!key || !['accept', 'dismiss', 'restore', 'handled', 'queueTerm', 'toGlossary', 'toPassport'].includes(action)) {
        return res.status(400).json({ error: 'Expected { key, action: accept|dismiss|restore|handled|queueTerm|toGlossary|toPassport }' });
    }
    const file = transReviewPath(prefix);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'No review for this project' });

    let review, state;
    try {
        review = readJson(file);
        state = readJson(statePath(prefix));
    } catch (e) { return res.status(500).json({ error: e.message }); }

    const finding = (review.findings || []).find(f => findingKey(f) === String(key).toLowerCase());
    if (!finding) return res.status(404).json({ error: 'No such finding' });

    if (action === 'dismiss') {
        review.dismissed = [...new Set([...(review.dismissed || []), String(key).toLowerCase()])];
        writeJsonAtomic(file, review);
        return res.json({ ok: true, dismissed: review.dismissed.length });
    }

    // Back into the open list. A dismissal is a judgement, and a judgement made
    // in a hurry over sixty findings is one a person may want back — the finding
    // itself was never deleted, only hidden. Both lists are cleared because both
    // close a finding, and taking it back means taking back whichever one closed
    // it; a key sits in one of them or in neither. A decision inherited by place
    // (see carryDecisions) is taken back together with the ones it came from,
    // or the next review would hand it straight back.
    if (action === 'restore') {
        const gone = new Set();
        for (let k = String(key).toLowerCase(); k && !gone.has(k); k = review.carriedFrom?.[k]) gone.add(k);
        review.dismissed = (review.dismissed || []).filter(x => !gone.has(String(x).toLowerCase()));
        review.handled = (review.handled || []).filter(x => !gone.has(String(x).toLowerCase()));
        if (review.carriedFrom) for (const k of gone) delete review.carriedFrom[k];
        writeJsonAtomic(file, review);
        return res.json({ ok: true, dismissed: review.dismissed.length });
    }

    // Dealt with, as opposed to wrong. Kept in its own list so the dismissals
    // stay usable as evidence about how far a finding can be trusted.
    if (action === 'handled') {
        review.handled = [...new Set([...(review.handled || []), String(key).toLowerCase()])];
        writeJsonAtomic(file, review);
        return res.json({ ok: true, handled: review.handled.length });
    }

    // The glossary edit the finding proposes, sent to the glossary editor's list
    // of proposals, where it is accepted like any glossary review finding — one
    // place, one set of checks. The finding stays open, marked as sent: what is
    // left is the translation already written with the old entry, and queueing
    // those chunks (or "Done") is what closes it.
    if (action === 'toGlossary') {
        if (!finding.glossaryEdits?.length) {
            return res.status(400).json({ error: 'This finding proposes no glossary edit' });
        }
        let glossaryReview = { findings: [], dismissed: [] };
        if (fs.existsSync(reviewPath(prefix))) {
            try { glossaryReview = readJson(reviewPath(prefix)); }
            catch (e) { return res.status(500).json({ error: `Could not read the glossary review: ${e.message}` }); }
        }
        const transferred = Array.isArray(glossaryReview.transferred) ? glossaryReview.transferred : [];
        const known = new Set([...(glossaryReview.findings || []), ...transferred].map(glossaryFindingKey));
        // Sent before and dismissed in the editor: sending it again is a new
        // decision, so the dismissal goes.
        const keys = finding.glossaryEdits.map(glossaryFindingKey);
        glossaryReview.dismissed = (glossaryReview.dismissed || []).filter(k => !keys.includes(String(k).toLowerCase()));
        for (const edit of finding.glossaryEdits) {
            if (!known.has(glossaryFindingKey(edit))) transferred.push({ ...edit, from: 'translation' });
        }
        glossaryReview.transferred = transferred;
        writeJsonAtomic(reviewPath(prefix), glossaryReview);
        const k = String(key).toLowerCase();
        review.sent = [...new Set([...(review.sent || []), k])];
        writeJsonAtomic(file, review);
        return res.json({ ok: true, sent: finding.glossaryEdits.length });
    }

    // A passport finding becomes a note for the translator, proposed: it is
    // accepted or rejected on the passport page, like the model's own notes.
    // Once accepted it reaches every chunk translated from now on (between its
    // boundaries, if it has them);
    // what is already translated is the chunk findings' business.
    if (action === 'toPassport') {
        const note = finding.note || (finding.advice ? { topic: finding.issue, advice: finding.advice } : null);
        if (finding.scope !== 'passport' || !note) {
            return res.status(400).json({ error: 'This finding carries no note for the passport' });
        }
        if (!fs.existsSync(passportPath(prefix))) {
            return res.status(409).json({ error: 'This project has no passport yet' });
        }
        let passport;
        try { passport = readJson(passportPath(prefix)); } catch (e) { return res.status(500).json({ error: e.message }); }
        passport.notes = Array.isArray(passport.notes) ? passport.notes : [];
        const same = passport.notes.find(n => String(n.advice || '').trim().toLowerCase() === note.advice.trim().toLowerCase());
        // Where it starts and stops holding, if the reviewer saw that it changes.
        const bounds = { ...(note.from ? { from: note.from } : {}), ...(note.until ? { until: note.until } : {}) };
        // A note already there keeps the decision made about it.
        if (same) Object.assign(same, bounds);
        else passport.notes.push({ topic: note.topic || '', advice: note.advice, status: 'proposed', source: 'review', ...bounds });
        writeJsonAtomic(passportPath(prefix), { ...passport, updatedAt: new Date().toISOString() });
        const k = String(key).toLowerCase();
        review.handled = [...new Set([...(review.handled || []), k])];
        writeJsonAtomic(file, review);
        return res.json({ ok: true });
    }

    // Fixing a glossary entry changes nothing already translated. This queues the
    // chunks that use the term, so the correction reaches the book — offered
    // rather than done automatically, because on Morphotrophic one of these terms
    // sits in 21 chunks of 169 and that is a real bill.
    if (action === 'queueTerm') {
        const term = finding.term || finding.glossaryEdits?.find(e => e.action !== 'add')?.entry;
        if (finding.scope !== 'glossary' || !term) {
            return res.status(400).json({ error: 'This finding names no glossary entry, so there is nothing to look for' });
        }
        const k = String(key).toLowerCase();
        const glossary = readGlossaryOrEmpty(prefix);
        const affected = chunksUsingTerm(state.chunks || [], term, glossary);
        // What the entry says now, beside the complaint: the chunk is fixed to
        // the glossary as corrected, and the complaint alone does not say what
        // the correction was.
        const entry = glossary.find(e => String(e.original || '').trim().toLowerCase() === term.trim().toLowerCase());
        const advice = entry?.translation ? `${finding.problem} (${term} → ${entry.translation})` : finding.problem;
        for (const i of affected) {
            const chunk = state.chunks[i];
            chunk.advice = (chunk.advice || []).filter(a => a.key !== k);
            chunk.advice.push({ key: k, issue: finding.issue, advice, quote: finding.quote, term });
        }
        state.metadata = state.metadata || {};
        state.metadata.updatedAt = new Date().toISOString();
        writeJsonAtomic(statePath(prefix), state);
        // Acted on: the work it asked for is queued, so it should not keep asking.
        review.handled = [...new Set([...(review.handled || []), k])];
        writeJsonAtomic(file, review);
        return res.json({ ok: true, queued: affected.length, chunks: affected.map(i => i + 1) });
    }

    // Scope is the model's routing hint, and it gets it wrong: the bilingual
    // review of Morphotrophic sent four findings to the glossary and the passport
    // that said, in their own words, "the glossary fixes X and this says Y" —
    // which is a chunk disobeying a correct glossary. What decides whether a
    // finding can be queued is whether it says what to do, not where it thinks it
    // belongs.
    if (!finding.advice) {
        return res.status(400).json({
            error: `This finding carries no advice, so there is nothing to tell the translator. ` +
                `It is filed under "${finding.scope}" — fix it there.`,
        });
    }
    const chunk = state.chunks?.[finding.chunk];
    if (!chunk) return res.status(404).json({ error: 'Chunk not found' });

    const k = String(key).toLowerCase();
    chunk.advice = (chunk.advice || []).filter(a => a.key !== k);
    if (action === 'accept') {
        chunk.advice.push({ key: k, issue: finding.issue, advice: finding.advice, quote: finding.quote });
    }
    if (!chunk.advice.length) delete chunk.advice;

    state.metadata = state.metadata || {};
    state.metadata.updatedAt = new Date().toISOString();
    writeJsonAtomic(statePath(prefix), state);
    res.json({ ok: true, chunk: finding.chunk, queued: chunk.advice?.length || 0 });
});

/**
 * Take a piece of advice off a chunk, by the chunk it sits on.
 *
 * The decision endpoint above can only undo what it can still find in the
 * review, and the queue outlives reviews: a second pass writes new findings
 * while the advice accepted from the first stays where it was put. Addressed by
 * chunk and key, with no key meaning the whole chunk's queue, because that is
 * how it is read on the screen — a chunk, and what is waiting to be done to it.
 */
app.post('/api/projects/:prefix/advice/remove', (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    if (jobManager.isRunning(prefix)) {
        return res.status(409).json({ error: 'Этап выполняется — очередь заблокирована' });
    }
    const { chunk: index, key } = req.body || {};
    if (!Number.isInteger(index) || index < 0) {
        return res.status(400).json({ error: 'Expected { chunk: <index>, key?: <finding key> }' });
    }

    let state;
    try { state = readJson(statePath(prefix)); }
    catch { return res.status(404).json({ error: 'Project not found' }); }

    const chunk = state.chunks?.[index];
    if (!chunk) return res.status(404).json({ error: 'Chunk not found' });
    const before = (chunk.advice || []).length;
    if (!before) return res.status(404).json({ error: 'Nothing is queued on that chunk' });

    chunk.advice = key
        ? chunk.advice.filter(a => String(a.key || '').toLowerCase() !== String(key).toLowerCase())
        : [];
    if (!chunk.advice.length) delete chunk.advice;
    if ((chunk.advice?.length || 0) === before) {
        return res.status(404).json({ error: 'No such advice on that chunk' });
    }

    state.metadata = state.metadata || {};
    state.metadata.updatedAt = new Date().toISOString();
    writeJsonAtomic(statePath(prefix), state);
    res.json({ ok: true, chunk: index, queued: chunk.advice?.length || 0 });
});

/**
 * Queue advice a person wrote on one or more chunks — see core/manual_advice.js.
 *
 * The chunks are named by number ("3, 7-12"), found by a phrase in the
 * translation or the original, or both together. With `preview` nothing is
 * written: the answer says which chunks the request would reach, so the form
 * can show them before anything is queued.
 */
app.post('/api/projects/:prefix/advice/add', (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    const { advice, quote, chunks: spec, search, where, preview } = req.body || {};
    const text = String(advice || '').trim();
    if (!preview && !text) return res.status(400).json({ error: 'Напишите, что исправить' });
    if (!String(spec || '').trim() && !String(search || '').trim()) {
        return res.status(400).json({ error: 'Укажите номера кусков или текст для поиска' });
    }
    if (!preview && jobManager.isRunning(prefix)) {
        return res.status(409).json({ error: 'Этап выполняется — очередь заблокирована' });
    }

    let state;
    try { state = readJson(statePath(prefix)); }
    catch { return res.status(404).json({ error: 'Project not found' }); }
    const chunks = state.chunks || [];

    const listed = parseChunkList(spec, chunks.length);
    if (listed.bad.length) {
        return res.status(400).json({ error: `Нет таких кусков: ${listed.bad.join(', ')} (в книге ${chunks.length})` });
    }
    const found = String(search || '').trim() ? chunksContaining(chunks, search, where) : [];
    const reached = [...new Set([...listed.indices, ...found])].sort((a, b) => a - b);
    // With nothing translated there is nothing to fix; those are reported, not queued.
    const ready = reached.filter(i => String(chunks[i]?.translation || '').trim());
    const untranslated = reached.filter(i => !ready.includes(i));

    if (preview || !ready.length) {
        return res.json({ ok: true, preview: true, chunks: ready, untranslated });
    }

    const key = manualKey();
    const item = { key, issue: 'manual', advice: text.slice(0, 2000) };
    const q = String(quote || '').trim();
    if (q) item.quote = q.slice(0, 600);
    for (const i of ready) chunks[i].advice = [...(chunks[i].advice || []), item];

    state.metadata = state.metadata || {};
    state.metadata.updatedAt = new Date().toISOString();
    writeJsonAtomic(statePath(prefix), state);
    res.json({ ok: true, key, chunks: ready, untranslated });
});
