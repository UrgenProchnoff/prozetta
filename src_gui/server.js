import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { jobManager } from './jobs.js';
import { createRawClient, PROVIDER_CONFIG_KEY } from '../src_v4/core/llm_client.js';

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

// A chunk counts as extracted if Stage 1 marked it done. Older projects predate
// the extraction_status field but still carry the extracted_terms array.
function isExtracted(chunk) {
    return chunk.extraction_status === 'success' || Array.isArray(chunk.extracted_terms);
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

function fieldType(v) {
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
            return { key, type: fieldType(m[key]), value: m[key], overridden: !!overridden };
        });
        groups.push({ id, kind: 'model', fields });
    }

    const p = cfg.pipeline || {};
    const pFields = Object.keys(p).map(key => ({
        key, type: fieldType(p[key]), value: p[key],
        overridden: !!(ovr.pipeline && Object.prototype.hasOwnProperty.call(ovr.pipeline, key))
    }));
    groups.push({ id: 'pipeline', kind: 'pipeline', fields: pFields });

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
    const validGroups = [...MODEL_GROUPS, 'pipeline'];

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

            const coerced = coerce(fieldType(base[key]), raw);
            if (coerced === null) {
                return res.status(400).json({ error: `Invalid value for ${groupId}.${key}` });
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
        const coerced = coerce(fieldType(base[key]), raw);
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
