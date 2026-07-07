import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { jobManager } from './jobs.js';
import { createRawClient, PROVIDER_CONFIG_KEY } from '../src_v4/core/llm_client.js';
import { assembleBookText, assembleBookFb2 } from '../src_v4/core/book_assembler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TXT_DIR = path.join(ROOT, 'txt');
const CONFIG_PATH = path.join(ROOT, 'src_v4', 'config.js');
const OVERRIDES_PATH = path.join(ROOT, 'src_v4', 'config.overrides.json');
const PORT = process.env.GUI_PORT || 3457;

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'web')));

// --- Helpers ---

// A project prefix is derived from the book's filename and becomes part of
// on-disk filenames (`<prefix>_project_state.json`) as well as a URL path
// segment and the Content-Disposition filename on download. So it must stay a
// single, safe path component: we allow spaces and Unicode letters (Cyrillic,
// etc.), but reject path separators, traversal and characters that are unsafe
// in filenames or HTTP headers.
const PREFIX_FORBIDDEN_RE = /[\\/:*?"<>|\x00-\x1f]/;

function isValidPrefix(prefix) {
    return typeof prefix === 'string'
        && prefix.length > 0
        && prefix.length <= 200
        && !PREFIX_FORBIDDEN_RE.test(prefix)
        && prefix !== '.'
        && prefix !== '..';
}

function statePath(prefix) {
    return path.join(ROOT, `${prefix}_project_state.json`);
}

function glossaryPath(prefix) {
    return path.join(ROOT, `${prefix}_glossary.json`);
}

function runLogPath(prefix) {
    return path.join(ROOT, `${prefix}_run.log`);
}

// Tail of the persistent per-project log written by src_v4 (survives GUI
// restarts, unlike the in-memory job log). Timestamps/levels are stripped so
// lines look the same as live SSE output; "=== RUN ... ===" separators stay.
const LOG_LINE_META_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z (INFO|WARN|ERROR) /;
function runLogTail(prefix, maxLines = 500) {
    try {
        const raw = fs.readFileSync(runLogPath(prefix), 'utf-8');
        return raw.split('\n')
            .filter(l => l.trim())
            .slice(-maxLines)
            .map(l => l.replace(LOG_LINE_META_RE, ''));
    } catch {
        return [];
    }
}

// The language suffix recorded for a project (e.g. "rus", "de"); defaults to
// "rus" for legacy projects with no langSuffix in metadata.
function projectSuffix(prefix) {
    try { return readJson(statePath(prefix)).metadata?.langSuffix || 'rus'; }
    catch { return 'rus'; }
}

// The assembled output filename for a project: <prefix>_<suffix>.<ext>.
// Language clones carry the suffix inside the prefix (e.g. "book_de" + "de"), so
// avoid doubling it: "book_de.txt" rather than "book_de_de.txt".
function outputFileName(prefix, suffix, ext = 'txt') {
    const s = suffix || projectSuffix(prefix);
    if (prefix.endsWith(`_${s}`)) return `${prefix}.${ext}`;
    return `${prefix}_${s}.${ext}`;
}

// The book cover lives next to the project state as <prefix>_cover.jpg|png.
function coverPath(prefix, ext) {
    return path.join(ROOT, `${prefix}_cover.${ext}`);
}

// Find the existing cover file for a project, or null.
function findCover(prefix) {
    for (const ext of ['jpg', 'png']) {
        const p = coverPath(prefix, ext);
        if (fs.existsSync(p)) return { path: p, ext, mime: ext === 'png' ? 'image/png' : 'image/jpeg' };
    }
    return null;
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function writeJsonAtomic(file, data) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
}

function validPrefix(req, res) {
    const prefix = req.params.prefix;
    if (!isValidPrefix(prefix)) {
        res.status(400).json({ error: 'Invalid project prefix' });
        return null;
    }
    return prefix;
}

function chunkStatus(chunk) {
    if (chunk.translation_status === 'success') return 'success';
    if (chunk.translation_status === 'failed_best_effort') return 'best_effort';
    if (chunk.history && chunk.history.length > 0) return 'in_progress';
    return 'pending';
}

// A chunk counts as extracted if Stage 1 marked it done — including 'blocked'
// (the content filter refused the text; Stage 1 skipped it permanently). Older
// projects predate the extraction_status field but still carry extracted_terms.
function isExtracted(chunk) {
    return chunk.extraction_status === 'success'
        || chunk.extraction_status === 'blocked'
        || Array.isArray(chunk.extracted_terms);
}

function lastScore(chunk) {
    if (!chunk.history) return null;
    for (let i = chunk.history.length - 1; i >= 0; i--) {
        const h = chunk.history[i];
        if (h.result && typeof h.result.score === 'number') return h.result.score;
    }
    return null;
}

function projectSummary(prefix) {
    const state = readJson(statePath(prefix));
    const chunks = state.chunks || [];
    const statuses = { success: 0, best_effort: 0, in_progress: 0, pending: 0 };
    let extracted = 0;

    const chunkList = chunks.map((c, i) => {
        const status = chunkStatus(c);
        statuses[status]++;
        const ext = isExtracted(c);
        if (ext) extracted++;
        return {
            i,
            tokens: c.tokens || null,
            status,
            extracted: ext,
            blocked: c.extraction_status === 'blocked',
            blockedBy: c.extraction_status === 'blocked' ? (c.blocked_by || null) : null,
            nTerms: Array.isArray(c.extracted_terms) ? c.extracted_terms.length : null,
            score: lastScore(c),
            attempts: c.history ? c.history.length : 0,
            preview: (c.original || '').slice(0, 80)
        };
    });

    let glossaryCount = null;
    if (fs.existsSync(glossaryPath(prefix))) {
        try { glossaryCount = readJson(glossaryPath(prefix)).length; } catch { glossaryCount = 0; }
    }

    return {
        prefix,
        metadata: state.metadata || {},
        total: chunks.length,
        statuses,
        extracted,
        glossaryCount,
        running: jobManager.isRunning(prefix),
        chunks: chunkList
    };
}

// Resolve the --file argument for a project. On an existing project the file
// only identifies the prefix; on a fresh one Stage 1/2 read it to build chunks.
function resolveSourceFile(prefix) {
    const sp = statePath(prefix);
    if (fs.existsSync(sp)) {
        try {
            const meta = readJson(sp).metadata || {};
            if (meta.sourceFile) {
                const base = path.basename(meta.sourceFile, path.extname(meta.sourceFile));
                if (base === prefix) return meta.sourceFile;
            }
        } catch { /* fall through */ }
    }
    if (fs.existsSync(TXT_DIR)) {
        const outName = outputFileName(prefix);
        const hit = fs.readdirSync(TXT_DIR).find(f =>
            path.basename(f, path.extname(f)) === prefix && f !== outName);
        if (hit) return path.join('txt', hit);
    }
    return path.join('txt', `${prefix}.txt`);
}

// --- API: projects ---

app.get('/api/projects', (req, res) => {
    const projects = [];
    for (const f of fs.readdirSync(ROOT)) {
        if (!f.endsWith('_project_state.json')) continue;
        const prefix = f.slice(0, -'_project_state.json'.length);
        if (!isValidPrefix(prefix)) continue;
        try {
            const s = projectSummary(prefix);
            delete s.chunks; // keep the dashboard payload small
            projects.push(s);
        } catch (e) {
            projects.push({ prefix, error: e.message });
        }
    }
    projects.sort((a, b) => (b.metadata?.updatedAt || '').localeCompare(a.metadata?.updatedAt || ''));

    // Books in txt/ that have no project yet. Skip assembled outputs: each known
    // project's <prefix>_<suffix>.txt (suffix from its metadata), plus a legacy
    // _rus.txt safety net for any output whose project state is unreadable.
    const known = new Set(projects.map(p => p.prefix));
    const outputs = new Set(projects.map(p => outputFileName(p.prefix, p.metadata?.langSuffix)));
    const newBooks = [];
    if (fs.existsSync(TXT_DIR)) {
        for (const f of fs.readdirSync(TXT_DIR)) {
            if (!f.endsWith('.txt') || f.endsWith('_rus.txt') || outputs.has(f)) continue;
            const prefix = path.basename(f, '.txt');
            if (!known.has(prefix)) newBooks.push({ file: path.join('txt', f), prefix });
        }
    }

    res.json({ projects, newBooks });
});

// --- API: upload a new book ---
// Raw body + filename in the query string — no multipart parser dependency.
// The file is decoded (UTF-8 / UTF-16 with BOM / windows-1251 fallback) and
// always saved to txt/ as clean UTF-8 so the pipeline never sees a legacy
// encoding. Errors carry a `code` the client maps to a localized message.

function decodeBookBuffer(buf) {
    if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE)
        return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le' };
    if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF)
        return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'utf-16be' };
    if (buf.includes(0)) return null; // NUL bytes → not a text file
    try {
        return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' };
    } catch {
        // Not valid UTF-8 → a legacy single-byte Cyrillic file is the likely case.
        return { text: new TextDecoder('windows-1251').decode(buf), encoding: 'windows-1251' };
    }
}

app.post('/api/upload', express.raw({ type: () => true, limit: '100mb' }), (req, res) => {
    const base = path.basename(String(req.query.name || ''));
    if (!/\.txt$/i.test(base)) {
        return res.status(400).json({ code: 'not_txt', error: 'Only .txt files are supported' });
    }
    // The prefix becomes part of filenames and URLs — keep it a safe path component.
    const prefix = base.slice(0, -4).replace(new RegExp(PREFIX_FORBIDDEN_RE.source, 'g'), '_').trim();
    if (!isValidPrefix(prefix)) {
        return res.status(400).json({ code: 'bad_name', error: 'Invalid file name' });
    }

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ code: 'empty', error: 'The file is empty' });
    }
    const decoded = decodeBookBuffer(req.body);
    if (!decoded) {
        return res.status(400).json({ code: 'binary', error: 'The file does not look like plain text' });
    }

    const target = path.join(TXT_DIR, `${prefix}.txt`);
    if (fs.existsSync(target) || fs.existsSync(statePath(prefix))) {
        return res.status(409).json({ code: 'exists', error: 'A book or project with this name already exists' });
    }

    fs.mkdirSync(TXT_DIR, { recursive: true });
    fs.writeFileSync(target, decoded.text.replace(/^\uFEFF/, ''));
    res.json({ ok: true, prefix, file: path.join('txt', `${prefix}.txt`), encoding: decoded.encoding });
});

app.get('/api/projects/:prefix/summary', async (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    if (!fs.existsSync(statePath(prefix))) return res.status(404).json({ error: 'Project not found' });
    const s = projectSummary(prefix);
    // The grid colours chunk scores using the same thresholds the pipeline
    // uses for its approve/fix/redraft decisions.
    try {
        const p = (await loadEffectiveConfig()).pipeline || {};
        s.scoreThresholds = { approval: p.approvalScoreThreshold, redraft: p.redraftScoreThreshold };
    } catch { /* config unreadable — the grid falls back to default bands */ }
    res.json(s);
});

// --- API: chunks ---

app.get('/api/projects/:prefix/chunks/:i', (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    const state = readJson(statePath(prefix));
    const i = parseInt(req.params.i, 10);
    const chunk = state.chunks?.[i];
    if (!chunk) return res.status(404).json({ error: 'Chunk not found' });
    res.json({ i, total: state.chunks.length, chunk });
});

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
        delete chunk.translation;
        delete chunk.translation_status;
        delete chunk.history;
    } else {
        if (typeof translation === 'string') chunk.translation = translation;
        if (typeof translation_status === 'string') chunk.translation_status = translation_status;
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

// --- API: glossary ---

app.get('/api/projects/:prefix/glossary', (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    const gp = glossaryPath(prefix);
    if (!fs.existsSync(gp)) return res.json({ terms: [], counts: [] });

    const terms = readJson(gp);

    // How many chunks mention each term — helps spotting junk entries
    let counts = [];
    if (fs.existsSync(statePath(prefix))) {
        const chunks = readJson(statePath(prefix)).chunks || [];
        const lower = chunks.map(c => (c.original || '').toLowerCase());
        counts = terms.map(t => {
            const needle = (t.original || '').toLowerCase();
            if (!needle) return 0;
            return lower.reduce((n, text) => n + (text.includes(needle) ? 1 : 0), 0);
        });
    }

    res.json({ terms, counts });
});

app.put('/api/projects/:prefix/glossary', (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    if (jobManager.isRunning(prefix)) {
        return res.status(409).json({ error: 'Этап выполняется — редактирование заблокировано' });
    }
    const terms = req.body;
    if (!Array.isArray(terms)) return res.status(400).json({ error: 'Expected an array of terms' });
    writeJsonAtomic(glossaryPath(prefix), terms);
    res.json({ ok: true, count: terms.length });
});

// --- API: jobs (run pipeline stages) ---

app.post('/api/run', (req, res) => {
    const { file, prefix: bodyPrefix, stage, model, lang, suffix } = req.body || {};

    if (!['1', '2', 'export'].includes(String(stage))) {
        return res.status(400).json({ error: 'stage must be 1, 2 or export' });
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

    const args = ['src_v4/main.js', `--stage=${stage}`, `--file=${sourceFile}`];
    if (model && model !== 'default') args.push(`--model=${model}`);
    // Language is set once at Stage 1; passing it on other stages just overrides.
    if (cleanLang) args.push(`--lang=${cleanLang}`);
    if (typeof suffix === 'string' && suffix.trim() !== '') args.push(`--suffix=${suffix.trim()}`);

    jobManager.start(prefix, args, ROOT);
    res.json({ ok: true, prefix, args });
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
    // After a GUI restart the in-memory log is empty — restore history from
    // the persistent <prefix>_run.log instead.
    if (job.log.length === 0) {
        const tail = runLogTail(prefix);
        if (tail.length > 0) return res.json({ ...job, log: tail, fromFile: true });
    }
    res.json(job);
});

// Revert the whole project to its post-Stage-1 state: keep extracted terms,
// drop all translation output (translation, status, history) so Stage 2 can be
// re-run from scratch. Mirrors src_v4/tools/reset_to_stage1.js. Backs up first.
app.post('/api/projects/:prefix/reset-stage1', (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    if (jobManager.isRunning(prefix)) {
        return res.status(409).json({ error: 'Этап выполняется — сброс заблокирован' });
    }

    const file = statePath(prefix);
    let state;
    try { state = readJson(file); } catch { return res.status(404).json({ error: 'Project not found' }); }

    // Backup the current state before mutating.
    const backupPath = path.join(ROOT, `${prefix}_project_state_before_reset.json.bak`);
    fs.copyFileSync(file, backupPath);

    let modified = 0;
    state.chunks = (state.chunks || []).map(chunk => {
        if (chunk.translation || chunk.history || chunk.translation_status) modified++;
        return {
            original: chunk.original,
            extracted_terms: chunk.extracted_terms,
            extraction_status: chunk.extraction_status,
        };
    });

    state.metadata = state.metadata || {};
    state.metadata.lastReset = new Date().toISOString();
    state.metadata.updatedAt = new Date().toISOString();
    writeJsonAtomic(file, state);

    res.json({ ok: true, modified, total: state.chunks.length, backup: path.basename(backupPath) });
});

// Clone a project to translate the same book into another language. Chunking and
// term extraction are language-independent, so we copy them as-is (extraction is
// skipped on the clone's Stage 1); only consolidation + Stage 2 re-run for the
// new language. The glossary is NOT copied — it would be in the wrong language.
app.post('/api/projects/:prefix/clone', (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;

    const { language, suffix } = req.body || {};
    if (!language || !String(language).trim()) {
        return res.status(400).json({ error: 'language is required' });
    }
    if (!/^[\w-]{1,20}$/.test(suffix || '')) {
        return res.status(400).json({ error: 'suffix must be 1-20 chars: letters, digits, _ or -' });
    }

    const newPrefix = `${prefix}_${suffix}`;
    if (!isValidPrefix(newPrefix)) return res.status(400).json({ error: 'Resulting prefix is invalid' });
    if (newPrefix === prefix) return res.status(400).json({ error: 'Suffix produces the same project' });
    if (fs.existsSync(statePath(newPrefix))) {
        return res.status(409).json({ error: `Проект "${newPrefix}" уже существует` });
    }

    let src;
    try { src = readJson(statePath(prefix)); } catch { return res.status(404).json({ error: 'Project not found' }); }

    const now = new Date().toISOString();
    const clone = {
        chunks: (src.chunks || []).map(c => ({
            original: c.original,
            extracted_terms: c.extracted_terms,
            extraction_status: c.extraction_status,
        })),
        metadata: {
            ...(src.metadata || {}),
            targetLanguage: String(language).trim(),
            langSuffix: suffix,
            clonedFrom: prefix,
            createdAt: now,
            updatedAt: now,
        },
    };
    // Start usage accounting fresh for the new language.
    delete clone.metadata.usage;
    delete clone.metadata.lastReset;

    writeJsonAtomic(statePath(newPrefix), clone);
    // The cover is language-independent — share it with the clone.
    const cover = findCover(prefix);
    if (cover) { try { fs.copyFileSync(cover.path, coverPath(newPrefix, cover.ext)); } catch { /* best effort */ } }
    res.json({ ok: true, prefix: newPrefix, chunks: clone.chunks.length });
});

// Delete a project: state, glossary and the assembled output. The source text in
// txt/ is left untouched. The state file is backed up to .deleted.bak first.
app.post('/api/projects/:prefix/delete', (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    if (jobManager.isRunning(prefix)) {
        return res.status(409).json({ error: 'Этап выполняется — удаление заблокировано' });
    }

    const sp = statePath(prefix);
    if (!fs.existsSync(sp)) return res.status(404).json({ error: 'Project not found' });

    // Back up the state before removing it.
    try { fs.copyFileSync(sp, `${sp}.deleted.bak`); } catch { /* best effort */ }

    const removed = [];
    const targets = [
        sp, glossaryPath(prefix),
        runLogPath(prefix),
        path.join(TXT_DIR, outputFileName(prefix)),
        path.join(TXT_DIR, outputFileName(prefix, null, 'fb2')),
        coverPath(prefix, 'jpg'), coverPath(prefix, 'png'),
    ];
    for (const f of targets) {
        try { if (fs.existsSync(f)) { fs.unlinkSync(f); removed.push(path.basename(f)); } } catch { /* best effort */ }
    }

    res.json({ ok: true, removed });
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

// --- API: book metadata (title/author for export) + cover ---

app.get('/api/projects/:prefix/book-meta', (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    let state;
    try { state = readJson(statePath(prefix)); } catch { return res.status(404).json({ error: 'Project not found' }); }
    const book = state.metadata?.book || {};
    res.json({
        title: book.title || '',
        author: book.author || '',
        langSuffix: state.metadata?.langSuffix || 'rus',
        hasCover: !!findCover(prefix),
    });
});

app.put('/api/projects/:prefix/book-meta', (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    if (jobManager.isRunning(prefix)) {
        return res.status(409).json({ error: 'Этап выполняется — редактирование заблокировано' });
    }
    const file = statePath(prefix);
    let state;
    try { state = readJson(file); } catch { return res.status(404).json({ error: 'Project not found' }); }

    const { title, author } = req.body || {};
    state.metadata = state.metadata || {};
    state.metadata.book = {
        ...(state.metadata.book || {}),
        title: String(title ?? '').trim().slice(0, 300),
        author: String(author ?? '').trim().slice(0, 300),
    };
    state.metadata.updatedAt = new Date().toISOString();
    writeJsonAtomic(file, state);
    res.json({ ok: true });
});

// Cover upload: raw image body, like /api/upload. Type is sniffed from magic
// bytes (JPEG/PNG only — what FB2 readers reliably support).
app.post('/api/projects/:prefix/cover', express.raw({ type: () => true, limit: '10mb' }), (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    if (!fs.existsSync(statePath(prefix))) return res.status(404).json({ error: 'Project not found' });

    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
        return res.status(400).json({ code: 'empty', error: 'The file is empty' });
    }
    let ext = null;
    if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) ext = 'jpg';
    else if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) ext = 'png';
    if (!ext) {
        return res.status(400).json({ code: 'bad_image', error: 'Cover must be a JPEG or PNG image' });
    }

    // Drop the other-extension leftover so there is never an ambiguous pair.
    for (const e of ['jpg', 'png']) {
        if (e !== ext) { try { fs.unlinkSync(coverPath(prefix, e)); } catch { /* none */ } }
    }
    fs.writeFileSync(coverPath(prefix, ext), buf);
    res.json({ ok: true, ext });
});

app.get('/api/projects/:prefix/cover', (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    const cover = findCover(prefix);
    if (!cover) return res.status(404).json({ error: 'No cover' });
    res.setHeader('Content-Type', cover.mime);
    res.setHeader('Cache-Control', 'no-cache');
    res.send(fs.readFileSync(cover.path));
});

app.delete('/api/projects/:prefix/cover', (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    const cover = findCover(prefix);
    if (cover) { try { fs.unlinkSync(cover.path); } catch { /* best effort */ } }
    res.json({ ok: true });
});

// --- API: export download ---

app.get('/api/projects/:prefix/output', async (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    const format = req.query.format === 'fb2' ? 'fb2' : 'txt';

    // Assemble on demand from the current project state so the download always
    // reflects the latest translations, with no separate "export" step required.
    let state;
    try { state = readJson(statePath(prefix)); } catch { return res.status(404).json({ error: 'Project not found' }); }
    const chunks = state.chunks || [];
    if (!chunks.some(c => c && c.translation)) {
        return res.status(409).json({ error: 'Нет переведённых чанков — переводить нечего' });
    }

    let modelName = '—';
    try {
        const cfg = await loadEffectiveConfig();
        modelName = cfg[PROVIDER_CONFIG_KEY[cfg.activeProvider]]?.modelName || modelName;
    } catch { /* keep placeholder */ }

    if (format === 'fb2') {
        const book = state.metadata?.book || {};
        const coverFile = findCover(prefix);
        const cover = coverFile
            ? { base64: fs.readFileSync(coverFile.path).toString('base64'), mime: coverFile.mime }
            : null;
        const { xml } = assembleBookFb2(chunks, {
            title: book.title || prefix,
            author: book.author || '',
            langSuffix: state.metadata?.langSuffix,
            modelName,
            cover,
        });
        const outName = outputFileName(prefix, state.metadata?.langSuffix, 'fb2');
        try { fs.writeFileSync(path.join(TXT_DIR, outName), xml); } catch { /* best effort */ }
        res.setHeader('Content-Type', 'application/x-fictionbook+xml; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${outName}"`);
        return res.send(xml);
    }

    const { text } = assembleBookText(chunks, modelName);

    const outName = outputFileName(prefix, state.metadata?.langSuffix);

    // Persist the assembled file too (so the CLI/txt dir stays in sync).
    try { fs.writeFileSync(path.join(TXT_DIR, outName), text); } catch { /* best effort */ }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${outName}"`);
    res.send(text);
});

// --- API: settings (config.js defaults + config.overrides.json) ---

const MODEL_GROUPS = ['logic_model', 'google_model', 'groq_model'];
const PROVIDERS = ['local', 'google', 'groq'];

function readOverrides() {
    if (!fs.existsSync(OVERRIDES_PATH)) return {};
    try { return JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf-8')); }
    catch { return {}; }
}

// Load the effective config fresh (defaults merged with overrides). Cache-bust
// the dynamic import so edits are reflected without restarting the server.
async function loadEffectiveConfig() {
    const url = pathToFileURL(CONFIG_PATH).href + `?t=${Date.now()}`;
    const mod = await import(url);
    return mod.default;
}

// Keys that are always fractional. Without this, a whole-number current value
// (e.g. temperature saved as 0) would be typed as 'int', making the browser
// reject fractional input and parseInt truncate it on save.
const FLOAT_KEYS = new Set(['temperature']);

function fieldType(key, v) {
    if (FLOAT_KEYS.has(key)) return 'float';
    if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
    if (typeof v === 'boolean') return 'bool';
    return 'string';
}

// Build a data-driven description of editable fields from the effective config.
// apiKey values are never sent to the browser — only whether one is set.
function describeConfig(cfg, overrides) {
    const groups = [];
    const ovr = overrides || {};

    for (const id of MODEL_GROUPS) {
        const m = cfg[id];
        if (!m) continue;
        const fields = Object.keys(m).map(key => {
            const overridden = ovr[id] && Object.prototype.hasOwnProperty.call(ovr[id], key);
            if (key === 'apiKey') return { key, type: 'secret', set: !!m[key], overridden: !!overridden };
            return { key, type: fieldType(key, m[key]), value: m[key], overridden: !!overridden };
        });
        groups.push({ id, kind: 'model', fields });
    }

    const p = cfg.pipeline || {};
    const pFields = Object.keys(p).map(key => ({
        key, type: fieldType(key, p[key]), value: p[key],
        overridden: !!(ovr.pipeline && Object.prototype.hasOwnProperty.call(ovr.pipeline, key))
    }));
    groups.push({ id: 'pipeline', kind: 'pipeline', fields: pFields });

    const t = cfg.translation || {};
    const tFields = Object.keys(t).map(key => ({
        key, type: fieldType(key, t[key]), value: t[key],
        overridden: !!(ovr.translation && Object.prototype.hasOwnProperty.call(ovr.translation, key))
    }));
    groups.push({ id: 'translation', kind: 'translation', fields: tFields });

    return groups;
}

app.get('/api/config', async (req, res) => {
    try {
        const cfg = await loadEffectiveConfig();
        res.json({ groups: describeConfig(cfg, readOverrides()), activeProvider: cfg.activeProvider || 'local' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Coerce an incoming value to the type of the current effective value.
function coerce(type, raw) {
    if (type === 'int') { const n = parseInt(raw, 10); return Number.isFinite(n) ? n : null; }
    if (type === 'float') { const n = parseFloat(raw); return Number.isFinite(n) ? n : null; }
    if (type === 'bool') return !!raw;
    return String(raw);
}

app.put('/api/config', async (req, res) => {
    const body = req.body || {};
    let cfg;
    try { cfg = await loadEffectiveConfig(); } catch (e) { return res.status(500).json({ error: e.message }); }

    const overrides = readOverrides();
    const validGroups = [...MODEL_GROUPS, 'pipeline', 'translation'];

    if (body.activeProvider !== undefined) {
        if (!PROVIDERS.includes(body.activeProvider)) {
            return res.status(400).json({ error: `Invalid activeProvider: ${body.activeProvider}` });
        }
        overrides.activeProvider = body.activeProvider;
    }

    for (const groupId of Object.keys(body)) {
        if (!validGroups.includes(groupId)) continue; // ignore unknown groups
        const base = cfg[groupId];
        if (!base) continue;
        const incoming = body[groupId] || {};
        overrides[groupId] = overrides[groupId] || {};

        for (const key of Object.keys(incoming)) {
            if (!Object.prototype.hasOwnProperty.call(base, key)) continue; // ignore unknown keys
            const raw = incoming[key];

            if (key === 'apiKey') {
                // Empty string means "leave current value" — don't write it.
                if (typeof raw === 'string' && raw.trim() !== '') overrides[groupId].apiKey = raw;
                continue;
            }

            const coerced = coerce(fieldType(key, base[key]), raw);
            if (coerced === null) {
                return res.status(400).json({ error: `Invalid value for ${groupId}.${key}` });
            }
            if (groupId === 'translation' && key === 'promptLang' && !['ru', 'en'].includes(coerced)) {
                return res.status(400).json({ error: "promptLang must be 'ru' or 'en'" });
            }
            if (groupId === 'translation' && key === 'langSuffix' && !/^[\w-]{1,20}$/.test(coerced)) {
                return res.status(400).json({ error: 'langSuffix must be 1-20 chars: letters, digits, _ or -' });
            }
            overrides[groupId][key] = coerced;
        }
        if (Object.keys(overrides[groupId]).length === 0) delete overrides[groupId];
    }

    try {
        const tmp = OVERRIDES_PATH + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(overrides, null, 2));
        fs.renameSync(tmp, OVERRIDES_PATH);
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }

    const fresh = await loadEffectiveConfig();
    res.json({ ok: true, groups: describeConfig(fresh, overrides), activeProvider: fresh.activeProvider || 'local' });
});

app.post('/api/config/reset', async (req, res) => {
    try {
        if (fs.existsSync(OVERRIDES_PATH)) fs.unlinkSync(OVERRIDES_PATH);
        const cfg = await loadEffectiveConfig();
        res.json({ ok: true, groups: describeConfig(cfg, {}), activeProvider: cfg.activeProvider || 'local' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Send a tiny prompt to a provider to verify it responds. Tests the values
// from the form (merged over saved config); an empty apiKey keeps the saved one.
app.post('/api/config/test', async (req, res) => {
    const { provider, values } = req.body || {};
    if (!PROVIDERS.includes(provider)) {
        return res.status(400).json({ error: `Invalid provider: ${provider}` });
    }

    let cfg;
    try { cfg = await loadEffectiveConfig(); } catch (e) { return res.status(500).json({ error: e.message }); }

    const base = cfg[PROVIDER_CONFIG_KEY[provider]] || {};
    const conf = { ...base };
    const incoming = values || {};
    for (const key of Object.keys(incoming)) {
        if (!Object.prototype.hasOwnProperty.call(base, key)) continue; // ignore unknown keys
        const raw = incoming[key];
        if (key === 'apiKey') {
            if (typeof raw === 'string' && raw.trim() !== '') conf.apiKey = raw; // empty → keep saved
            continue;
        }
        const coerced = coerce(fieldType(key, base[key]), raw);
        if (coerced !== null) conf[key] = coerced;
    }

    const TEST_TIMEOUT_MS = 20000;
    const started = Date.now();
    try {
        const client = createRawClient(provider, conf);
        const result = await Promise.race([
            client.invoke('Reply with just: OK'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), TEST_TIMEOUT_MS)),
        ]);
        const content = result?.content;
        const reply = typeof content === 'string' ? content : JSON.stringify(content ?? '');
        res.json({ ok: true, latencyMs: Date.now() - started, model: conf.modelName, reply: reply.slice(0, 200) });
    } catch (e) {
        res.json({ ok: false, latencyMs: Date.now() - started, error: e.message || String(e) });
    }
});

app.listen(PORT, '127.0.0.1', () => {
    console.log(`[GUI] prozetta GUI running at http://127.0.0.1:${PORT}`);
});
