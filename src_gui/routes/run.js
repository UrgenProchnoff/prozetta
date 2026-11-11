/** Running the pipeline: starting and stopping a stage, whole-book calls carried by hand, live events. */
import fs from 'fs';
import path from 'path';
import { jobManager } from '../jobs.js';
import { buildStructurePrompt, applyStructureAnswer } from '../../src_v4/core/book_structure.js';
import { getPrompts } from '../../src_v4/prompts.js';
import { ProjectState } from '../../src_v4/core/state_manager.js';
import { countTokens } from '../../src_v4/core/tokenizer.js';
import { buildTranslationReviewPrompt, applyTranslationReview } from '../../src_v4/stages/05_translation_review.js';
import { buildGlossaryReviewPrompt, applyGlossaryReview } from '../../src_v4/stages/04_glossary_review.js';
import { buildPassportPrompt, applyPassportAnswer, buildPovMapPrompt, applyPovMapAnswer } from '../../src_v4/stages/03_passport.js';
import { extractJson, describeJsonError } from '../../src_v4/utils/parsers.js';
import config from '../../src_v4/config.js';
import { ROOT, app } from '../app.js';
import { isValidPrefix, statePath, runLogTail, validPrefix, projectSummary, resolveSourceFile } from '../helpers.js';

// --- API: jobs (run pipeline stages) ---

app.post('/api/run', (req, res) => {
    const { file, prefix: bodyPrefix, stage, model, lang, suffix } = req.body || {};

    if (!['1', 'passport', 'povmap', 'glossary', '2', 'review', 'export'].includes(String(stage))) {
        return res.status(400).json({ error: 'stage must be 1, passport, povmap, glossary, 2, review or export' });
    }

    let prefix, sourceFile;
    if (file) {
        sourceFile = file;
        prefix = path.basename(file, path.extname(file));
    } else if (bodyPrefix) {
        prefix = bodyPrefix;
        sourceFile = resolveSourceFile(prefix);
    } else {
        return res.status(400).json({ error: 'file or prefix is required' });
    }

    if (!isValidPrefix(prefix)) return res.status(400).json({ error: 'Invalid prefix' });
    if (jobManager.isRunning(prefix)) {
        return res.status(409).json({ error: 'Этап уже выполняется для этого проекта' });
    }

    // suffix becomes part of an output filename — keep it filename-safe.
    if (suffix !== undefined && suffix !== '' && !/^[\w-]{1,20}$/.test(String(suffix))) {
        return res.status(400).json({ error: 'suffix must be 1-20 chars: letters, digits, _ or -' });
    }
    const cleanLang = typeof lang === 'string' ? lang.replace(/[\r\n]/g, ' ').trim().slice(0, 60) : '';

    // A whole-book stage that will not fit is refused here rather than spawned to
    // fail. The check costs nothing now that chunks carry their own token counts,
    // and it answers the question a person is really asking by pressing Start:
    // "do this" — to which "it does not fit, here is the prompt to carry" is a
    // better answer than a process that starts and dies.
    const call = BOOK_CALLS[BOOK_STAGE[stage]];
    if (call) {
        try {
            const state = new ProjectState(ROOT, prefix);
            state.load();
            // Books translated before chunks carried their own token counts have
            // to be counted once, and counting a whole translation takes nine
            // seconds. Doing it here and keeping the result turns every later
            // check into a sum.
            if (fillTranslationTokens(state)) state.save();
            const built = call.build(state, {});
            if (built.tokens.total > built.budget) {
                return res.json({
                    ok: false, tooLarge: true, kind: BOOK_STAGE[stage],
                    tokens: built.tokens.total, budget: built.budget,
                });
            }
        } catch (e) {
            return res.status(400).json({ error: e.message });
        }
    }

    const args = ['src_v4/main.js', `--stage=${stage}`, `--file=${sourceFile}`];
    if (model && model !== 'default') args.push(`--model=${model}`);
    // Language is set once at extraction; passing it on other steps just overrides.
    if (cleanLang) args.push(`--lang=${cleanLang}`);
    if (typeof suffix === 'string' && suffix.trim() !== '') args.push(`--suffix=${suffix.trim()}`);

    jobManager.start(prefix, args, ROOT);
    res.json({ ok: true, prefix, args });
});

/**
 * The three whole-book calls, each split into building a prompt and applying an
 * answer, so either half can be done by hand — see src_v4/core/book_call.js.
 *
 * One table rather than three endpoints: the halves differ, the carrying does
 * not, and three copies of "hand this over, take that back" would drift the way
 * the delete list once did.
 */
/**
 * Give every translated chunk its own token count, if it has none.
 *
 * @returns {boolean} whether anything was added, and so whether to save
 */
function fillTranslationTokens(state) {
    let added = 0;
    for (const chunk of state.getChunks()) {
        if (chunk.translation && !chunk.translationTokens) {
            chunk.translationTokens = countTokens(chunk.translation);
            added++;
        }
    }
    if (added) console.log(`[GUI] Counted ${added} chunk translation(s) for "${state.filePrefix}" — done once.`);
    return added > 0;
}

/** Which runnable stage is which whole-book call. */
const BOOK_STAGE = { passport: 'passport', povmap: 'povmap', glossary: 'glossary', review: 'translation' };

const BOOK_CALLS = {
    translation: {
        build: (state, opts) => buildTranslationReviewPrompt(state, opts),
        apply: (state, raw, meta) => applyTranslationReview(state, raw, meta),
        // Only this one has anything to add when the window is bigger: the
        // original, which doubles the prompt and lets it judge meaning.
        variants: true,
    },
    glossary: {
        build: (state) => buildGlossaryReviewPrompt(state),
        apply: (state, raw, meta) => applyGlossaryReview(state, raw, meta),
    },
    passport: {
        build: (state) => buildPassportPrompt(state),
        apply: (state, raw, meta) => { applyPassportAnswer(state, raw, meta); return { notes: [] }; },
    },
    // Not a whole-book call — the candidate lines only — but carried by hand the
    // same way when the model is busy or the API is out of reach.
    structure: {
        build: (state) => ({ ...buildStructurePrompt(state.getChunks(), getPrompts(config.translation.promptLang)), budget: Infinity }),
        apply: (state, raw, meta) => { applyStructureAnswer(state.getChunks(), raw, state.getStructurePath(), meta); return { notes: [] }; },
    },
    povmap: {
        build: (state) => buildPovMapPrompt(state),
        apply: (state, raw, meta) => { applyPovMapAnswer(state, raw, meta); return { notes: [] }; },
    },
};

function bookCall(req, res) {
    const kind = String(req.params.kind || '');
    const call = BOOK_CALLS[kind];
    if (!call) { res.status(404).json({ error: `Unknown book call: ${kind}` }); return null; }
    return call;
}

/**
 * Hand a whole-book prompt over so it can be run somewhere else.
 *
 * The per-minute input quota, not the context window, is what refuses these
 * calls; a web console is a different quota surface with a far bigger window.
 * `original=1` (translation review only) pairs each chunk with its source, which
 * no free tier would take and a million-token window will.
 */
app.get('/api/projects/:prefix/book-call/:kind/prompt', (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    const call = bookCall(req, res);
    if (!call) return;

    let state;
    try { state = new ProjectState(ROOT, prefix); state.load(); }
    catch (e) { return res.status(500).json({ error: e.message }); }

    const withOriginal = call.variants && req.query.original === '1';
    let built;
    try { built = call.build(state, { withOriginal }); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    // The fingerprint travels inside the text, because it has to come back with
    // an answer a person carried by hand and there is nowhere else to put it.
    const text = `${built.system}\n\n${built.user}\n\n` +
        `<!-- prozetta: ${prefix} · ${req.params.kind} · fingerprint ${built.fingerprint} · ` +
        `${withOriginal ? 'bilingual' : 'single'} · ~${built.tokens.total} tokens -->\n`;

    if (req.query.download === '1') {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition',
            `attachment; filename="${req.params.kind}-prompt-${encodeURIComponent(prefix)}${withOriginal ? '-bilingual' : ''}.txt"`);
        return res.send(text);
    }
    res.json({
        ok: true,
        kind: req.params.kind,
        fingerprint: built.fingerprint,
        tokens: built.tokens,
        withOriginal: !!withOriginal,
        variants: !!call.variants,
        budget: built.budget,
        warnings: built.warnings || [],
        chars: text.length,
        text,
    });
});

/** Take an answer obtained elsewhere through exactly the checks an API one gets. */
app.post('/api/projects/:prefix/book-call/:kind/answer', (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    const call = bookCall(req, res);
    if (!call) return;
    if (jobManager.isRunning(prefix)) {
        return res.status(409).json({ error: 'Этап выполняется — приём ответа заблокирован' });
    }
    const { answer, model, fingerprint: fp, withOriginal } = req.body || {};
    if (typeof answer !== 'string' || !answer.trim()) {
        return res.status(400).json({ error: 'Expected { answer } — the model’s reply, JSON and all' });
    }

    let state;
    try { state = new ProjectState(ROOT, prefix); state.load(); }
    catch (e) { return res.status(500).json({ error: e.message }); }

    let raw;
    try { raw = extractJson(answer); }
    catch (e) {
        // "No JSON found" was said even when JSON had been found and was merely
        // broken, which is the usual case and a different repair. What the
        // parser knows — which line, and whether it is the unnamed-paragraph
        // break — goes to the interface as fields, so the page can say it in the
        // reader's language instead of quoting a parser at them.
        const d = describeJsonError(answer, e);
        return res.status(400).json({
            code: d.kind === 'none' ? 'no_json' : 'bad_json',
            error: e.message,
            line: d.line, column: d.column, excerpt: d.excerpt, hint: d.hint,
        });
    }

    try {
        const result = call.apply(state, raw, {
            model: String(model || '').trim() || 'unnamed (run by hand)',
            source: 'manual',
            fingerprint: fp,
            withOriginal: !!withOriginal,
            answerText: answer,
        }) || {};
        res.json({
            ok: true,
            returned: result.review?.returned ?? null,
            findings: result.findings?.length ?? null,
            rejected: result.rejected ?? null,
            notes: result.notes || [],
        });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.post('/api/projects/:prefix/stop', (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    const stopped = jobManager.stop(prefix);
    res.json({ ok: true, stopped });
});

app.get('/api/projects/:prefix/job', (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    const job = jobManager.getJob(prefix);
    // After a GUI restart the in-memory log is empty — restore history from the
    // persistent <prefix>_run.log instead. Only for a job that is not running:
    // a job that has just started is also empty, and answering it with five
    // hundred lines of a previous run presents old history as the current one.
    // Measured on the export stage, which prints nothing for its first 300 ms.
    if (job.log.length === 0 && !job.running) {
        const tail = runLogTail(prefix);
        if (tail.length > 0) return res.json({ ...job, log: tail, fromFile: true });
    }
    res.json(job);
});

// --- API: SSE live events (log lines + state file changes) ---

const watchers = new Map(); // prefix -> { count }

function ensureWatcher(prefix) {
    const file = statePath(prefix);
    const w = watchers.get(prefix);
    if (w) { w.count++; return; }
    watchers.set(prefix, { count: 1 });
    fs.watchFile(file, { interval: 1000 }, () => {
        try {
            const s = projectSummary(prefix);
            delete s.chunks;
            jobManager.broadcast(prefix, 'state', s);
        } catch { /* state mid-write or missing */ }
    });
}

function releaseWatcher(prefix) {
    const w = watchers.get(prefix);
    if (!w) return;
    if (--w.count <= 0) {
        fs.unwatchFile(statePath(prefix));
        watchers.delete(prefix);
    }
}

app.get('/api/projects/:prefix/events', (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });
    res.write(`event: job\ndata: ${JSON.stringify({ running: jobManager.isRunning(prefix) })}\n\n`);

    const unsubscribe = jobManager.subscribe(prefix, res);
    ensureWatcher(prefix);

    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
        clearInterval(ping);
        unsubscribe();
        releaseWatcher(prefix);
    });
});
