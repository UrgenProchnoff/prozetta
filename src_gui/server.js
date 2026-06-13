import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { jobManager } from './jobs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TXT_DIR = path.join(ROOT, 'txt');
const PORT = process.env.GUI_PORT || 3457;

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'web')));

// --- Helpers ---

const PREFIX_RE = /^[\w.-]+$/;

function statePath(prefix) {
    return path.join(ROOT, `${prefix}_project_state.json`);
}

function glossaryPath(prefix) {
    return path.join(ROOT, `${prefix}_glossary.json`);
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
    if (!PREFIX_RE.test(prefix)) {
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
        if (c.extracted_terms) extracted++;
        return {
            i,
            tokens: c.tokens || null,
            status,
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

// Resolve the --file argument for a project. Stage 2/export only use it to
// derive the prefix, so the file does not have to exist on disk.
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
        const hit = fs.readdirSync(TXT_DIR).find(f =>
            path.basename(f, path.extname(f)) === prefix && !f.endsWith('_rus.txt'));
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
        if (!PREFIX_RE.test(prefix)) continue;
        try {
            const s = projectSummary(prefix);
            delete s.chunks; // keep the dashboard payload small
            projects.push(s);
        } catch (e) {
            projects.push({ prefix, error: e.message });
        }
    }
    projects.sort((a, b) => (b.metadata?.updatedAt || '').localeCompare(a.metadata?.updatedAt || ''));

    // Books in txt/ that have no project yet
    const known = new Set(projects.map(p => p.prefix));
    const newBooks = [];
    if (fs.existsSync(TXT_DIR)) {
        for (const f of fs.readdirSync(TXT_DIR)) {
            if (!f.endsWith('.txt') || f.endsWith('_rus.txt')) continue;
            const prefix = path.basename(f, '.txt');
            if (!known.has(prefix)) newBooks.push({ file: path.join('txt', f), prefix });
        }
    }

    res.json({ projects, newBooks });
});

app.get('/api/projects/:prefix/summary', (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    if (!fs.existsSync(statePath(prefix))) return res.status(404).json({ error: 'Project not found' });
    res.json(projectSummary(prefix));
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
    const { file, prefix: bodyPrefix, stage, model } = req.body || {};

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

    if (!PREFIX_RE.test(prefix)) return res.status(400).json({ error: 'Invalid prefix' });
    if (jobManager.isRunning(prefix)) {
        return res.status(409).json({ error: 'Этап уже выполняется для этого проекта' });
    }

    const args = ['src_v4/main.js', `--stage=${stage}`, `--file=${sourceFile}`];
    if (model && model !== 'default') args.push(`--model=${model}`);

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
    res.json(jobManager.getJob(prefix));
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

// --- API: export download ---

app.get('/api/projects/:prefix/output', (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    const file = path.join(TXT_DIR, `${prefix}_rus.txt`);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Перевод ещё не экспортирован' });
    res.download(file);
});

app.listen(PORT, '127.0.0.1', () => {
    console.log(`[GUI] Translator GUI running at http://127.0.0.1:${PORT}`);
});
