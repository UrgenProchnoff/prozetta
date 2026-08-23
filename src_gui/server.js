import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { jobManager } from './jobs.js';
import { createRawClient, PROVIDER_CONFIG_KEY, BOOK_OWN_PROVIDER } from '../src_v4/core/llm_client.js';
import { assembleBookText, assembleBookFb2 } from '../src_v4/core/book_assembler.js';
import { glossaryFindings } from '../src_v4/tools/glossary_hygiene.js';
import { outstandingFindings as glossaryOutstanding } from '../src_v4/core/glossary_review.js';
import { projectPaths, projectDir, listProjects } from '../src_v4/core/paths.js';
import { handEdited } from '../src_v4/core/passport.js';
import { dominantMarker, deviatingChunks, adherence } from '../src_v4/core/dialogue.js';
import { inflectionGroups } from '../src_v4/core/glossary_forms.js';
import { withoutTranslation, ProjectState } from '../src_v4/core/state_manager.js';
import { wholeWordRegex } from '../src_v4/core/text_stats.js';
import { buildTranslationReviewPrompt, applyTranslationReview } from '../src_v4/stages/05_translation_review.js';
import { extractJson } from '../src_v4/utils/parsers.js';
import { outstandingFindings as reviewOutstanding, findingKey } from '../src_v4/core/translation_review.js';
import config from '../src_v4/config.js';

import { execFileSync } from 'child_process';

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

// Every path a project owns comes from one place, shared with the pipeline —
// see src_v4/core/paths.js. Two independent answers is what let the delete list
// go stale twice.
const paths = (prefix) => projectPaths(ROOT, prefix);
const statePath = (prefix) => paths(prefix).state;
const glossaryPath = (prefix) => paths(prefix).glossary;
const reviewPath = (prefix) => paths(prefix).review;
const transReviewPath = (prefix) => paths(prefix).translationReview;

/**
 * What version is running, resolved once at startup.
 *
 * The commit is the part that actually identifies a build: the package version
 * moves rarely, while the thing a person is looking at moves every day. Read
 * through git rather than from a baked file so it cannot drift from reality —
 * and it degrades to the package version alone when there is no checkout, which
 * is how an install from an archive looks.
 *
 * `dirty` matters more than it looks: most of the time this runs from a working
 * tree with edits in it, and a bare commit hash would then name a build that
 * does not exist anywhere.
 */
const VERSION = (() => {
    let version = '0.0.0';
    let repository = null;
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
        version = pkg.version || version;
        repository = String(pkg.repository?.url || pkg.repository || '').replace(/\.git$/, '') || null;
    } catch { /* keep the placeholder */ }

    const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    try {
        return {
            version,
            repository,
            commit: git('rev-parse', '--short', 'HEAD'),
            commitDate: git('log', '-1', '--format=%cI'),
            branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
            dirty: git('status', '--porcelain', '--untracked-files=no').length > 0,
        };
    } catch {
        return { version, repository, commit: null, commitDate: null, branch: null, dirty: false };
    }
})();

app.get('/api/version', (req, res) => {
    res.json({ ...VERSION, changelog: fs.existsSync(path.join(ROOT, 'CHANGELOG.md')) });
});

// A commit fingerprint, written either as `abc1234` at the head of an entry or
// as (abc1234, def5678) inside one. Both forms are recognised so the file can be
// reorganised without the links going quiet.
const COMMIT_REF_RE = /`([0-9a-f]{7,40})`|\(([0-9a-f]{7,40}(?:,\s*[0-9a-f]{7,40})*)\)/g;

/**
 * Look up every commit the changelog refers to, in one pass over the log rather
 * than one call per hash: the file names forty of them, and forty git processes
 * to render a page is forty too many.
 */
function describeCommits(text) {
    const wanted = new Set();
    for (const m of text.matchAll(COMMIT_REF_RE)) {
        for (const h of (m[1] || m[2] || '').split(/,\s*/)) if (h) wanted.add(h);
    }
    if (!wanted.size) return {};
    const found = {};
    try {
        const log = execFileSync('git', ['log', '--format=%h%x00%s%x00%cI', '--max-count=2000'],
            { cwd: ROOT, encoding: 'utf-8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
        for (const line of log.split('\n')) {
            const [hash, subject, date] = line.split('\0');
            if (hash && wanted.has(hash)) found[hash] = { subject, date };
        }
    } catch { /* no checkout: the refs stay plain text, which is still readable */ }
    return found;
}

// The changelog as written, for the interface to render. Read per request so an
// edit shows up without restarting the server.
//
// Translations follow the convention the README already uses: CHANGELOG.md is
// English, CHANGELOG.<lang>.md is everything else. A language with no file of
// its own falls back to English and says so, rather than showing nothing.
app.get('/api/changelog', (req, res) => {
    // The value decides a filename, so it is matched rather than interpolated.
    const lang = /^[a-z]{2}$/.test(String(req.query.lang || '')) ? String(req.query.lang) : 'en';
    const translated = path.join(ROOT, `CHANGELOG.${lang}.md`);
    const english = path.join(ROOT, 'CHANGELOG.md');

    const file = lang !== 'en' && fs.existsSync(translated) ? translated : english;
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'No CHANGELOG.md' });
    try {
        const text = fs.readFileSync(file, 'utf-8');
        res.json({
            text,
            lang: file === english ? 'en' : lang,
            requested: lang,
            repository: VERSION.repository,
            // Subject and date for every commit the file names, so an entry can
            // show what it points at and a hash that no longer resolves — a
            // typo, or a rebase — is visibly dead rather than a link to nothing.
            commits: describeCommits(text),
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

const passportPath = (prefix) => paths(prefix).passport;
const runLogPath = (prefix) => paths(prefix).log;

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

// The book cover lives in the project folder as cover.jpg|png.
const coverPath = (prefix, ext) => paths(prefix).cover(ext);

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

/**
 * How well a translation keeps to the marker its dialogue is supposed to open
 * with. `expected` is the passport's; where there is none the text is measured
 * against its own majority, and `expected: null` says so — that only answers
 * whether the book agrees with itself, never whether it agrees with the language.
 */

/**
 * Chunks whose source text uses a term, by index.
 *
 * Whole words through the shared matcher, which knows that a boundary cannot be
 * required in Chinese, Japanese, Korean or Thai.
 */
function chunksUsingTerm(chunks, term) {
    const re = wholeWordRegex(String(term), 'giu');
    const out = [];
    (chunks || []).forEach((c, i) => { if (c?.original && re.test(c.original)) out.push(i); });
    return out;
}

function speechAdherence(chunks, expected) {
    const translated = chunks.map(c => c.translation || '').filter(Boolean).join('\n');
    if (!translated) return null;
    const book = dominantMarker(translated);
    const reference = expected || book.marker;
    if (!reference) return null;
    const kept = adherence(book, reference);
    return {
        expected,
        observed: book.marker,
        marker: reference,
        share: kept ? Number(kept.share.toFixed(3)) : 0,
        counts: Object.fromEntries(book.tally.slice(0, 6)),
        deviations: deviatingChunks(chunks, book, reference).map(d => d.i),
    };
}


/**
 * Inflection groups as a per-row annotation.
 *
 * `group` numbers the members so the editor can bring them together, and
 * `spread` is how unlike their translations are — the sort key, and nothing
 * more. What the code cannot judge is whether a group is a real disagreement or
 * a singular beside its plural; that is a person's call, and the ranking exists
 * to put the ones worth a glance at the top.
 */
function formGroups(terms) {
    const byRow = new Array(terms.length).fill(null);
    inflectionGroups(terms).forEach((group, n) => {
        for (const entry of group.entries) {
            byRow[entry.index] = { group: n, spread: Number(group.spread.toFixed(2)), size: group.entries.length };
        }
    });
    return byRow;
}

function chunkStatus(chunk) {
    if (chunk.translation_status === 'success') return 'success';
    if (chunk.translation_status === 'failed_best_effort') return 'best_effort';
    // Refused by the content filter of the model that was translating. Its own
    // colour rather than "in progress": nothing is in progress, and the run has
    // already moved on. Only another model can pick it up.
    if (chunk.translation_status === 'blocked') return 'blocked';
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
    const statuses = { success: 0, best_effort: 0, blocked: 0, in_progress: 0, pending: 0 };
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
            // Which model refused to translate it. Separate from the two above,
            // which are about Stage 1: the same chunk can be refused by one model
            // at extraction and by another at translation.
            translationBlockedBy: c.translation_status === 'blocked' ? (c.translation_blocked_by || null) : null,
            // Translator and reviewer could not agree (repeated rejection of a
            // fresh draft) — the loop stopped instead of burning budget, and a
            // human should settle it.
            disputed: !!c.dispute,
            // Advice accepted from the whole-book review and waiting for the next
            // Stage 2 run. Work outstanding on a chunk that otherwise looks done,
            // so the map has to say so or 35 queued fixes are invisible.
            advice: c.advice?.length || 0,
            // Already corrected on advice at some point. The advice itself is
            // cleared once the fix is approved, so history is the only lasting
            // record that this chunk is not the one the reviewer read.
            fixed: (c.history || []).some(h => h.step === 'advice_fix'),
            nTerms: Array.isArray(c.extracted_terms) ? c.extracted_terms.length : null,
            score: lastScore(c),
            attempts: c.history ? c.history.length : 0,
            preview: (c.original || '').slice(0, 80)
        };
    });

    let passport = null;
    if (fs.existsSync(passportPath(prefix))) {
        try {
            const p = readJson(passportPath(prefix));
            passport = {
                kind: p.kind || null,
                person: p.narration?.person || null,
                characters: (p.characters || []).length,
                spans: (p.povMap || []).length,
                dialogue: p.dialogue?.marker ? p.dialogue : null,
                // Whether rebuilding it would take back somebody's corrections.
                edited: handEdited(p),
            };
        } catch { passport = { broken: true }; }
    }

    // Does the finished text keep to the marker the passport prescribes? Counted
    // from the translation, so it says nothing until there is one. Without a
    // passport the text is compared against its own majority — a weaker question
    // (does the book agree with itself?) and reported as such.
    const dialogue = speechAdherence(chunks, passport?.dialogue?.marker || null);

    let glossaryCount = null;
    let glossaryForms = null;
    if (fs.existsSync(glossaryPath(prefix))) {
        try {
            const gl = readJson(glossaryPath(prefix));
            glossaryCount = gl.length;
            // Entries that are forms of one source word translated two ways. Only
            // the worst few travel in the summary; the rest are a click away.
            const groups = inflectionGroups(gl);
            glossaryForms = {
                groups: groups.length,
                top: groups.slice(0, 5).map(g => ({
                    spread: Number(g.spread.toFixed(2)),
                    entries: g.entries.map(e => ({ original: e.original, translation: e.translation })),
                })),
            };
        } catch { glossaryCount = 0; }
    }

    // The book model's reading of the finished translation, resolved against the
    // translation as it stands: a finding whose quote has gone was acted on.
    let translationReview = null;
    if (fs.existsSync(transReviewPath(prefix))) {
        try {
            const r = readJson(transReviewPath(prefix));
            const { open, done, hidden } = reviewOutstanding(r, chunks);
            // For a glossary finding that names its entry: how many chunks use
            // that term. Fixing the glossary changes nothing already translated,
            // so this is the size of the work the finding actually implies, and
            // it has to be on screen before the button is pressed.
            for (const f of open) {
                if (f.scope !== 'glossary' || !f.term) continue;
                f.affects = chunksUsingTerm(chunks, f.term).length;
            }
            translationReview = {
                generatedAt: r.generatedAt || null,
                model: r.model || null,
                score: r.score ?? null,
                summary: r.summary || null,
                returned: r.returned ?? null,
                rejected: r.rejected || null,
                open, done, hidden,
                // Advice already accepted onto chunks, so the interface can show
                // what is queued for the next Stage 2 run without walking chunks.
                accepted: chunks.reduce((n, c) => n + (c.advice?.length || 0), 0),
            };
        } catch { translationReview = { broken: true }; }
    }

    let glossaryReview = null;
    if (fs.existsSync(reviewPath(prefix))) {
        try {
            const r = readJson(reviewPath(prefix));
            glossaryReview = { findings: (r.findings || []).length, generatedAt: r.generatedAt || null };
        } catch { glossaryReview = { broken: true }; }
    }

    return {
        prefix,
        metadata: state.metadata || {},
        total: chunks.length,
        statuses,
        extracted,
        glossaryCount,
        glossaryForms,
        glossaryReview,
        translationReview,
        passport,
        dialogue,
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
    for (const prefix of listProjects(ROOT)) {
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
    // The roadmap drops its whole-book steps when the large model is off, so it
    // has to be told here rather than guessing from whether artefacts exist.
    s.bookModel = await bookModelInfo();
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
        // Goes with the status it belongs to: left behind, it would claim a
        // block that the reset just erased.
        delete chunk.translation_blocked_by;
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

// --- API: passport ---
// The book passport holds decisions that hold for the whole book — narration
// person and tense, the form of address, the point-of-view cast with their
// dossiers, and which chunks belong to whom. It is built by --stage=passport
// and, like the glossary, is meant to be reviewed by a human.

app.get('/api/projects/:prefix/passport', (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    const pp = passportPath(prefix);
    if (!fs.existsSync(pp)) return res.json({ exists: false, passport: null });
    try {
        const passport = readJson(pp);
        // Chunk count lets the map be drawn to scale even where spans are sparse.
        let total = 0;
        let chunks = [];
        if (fs.existsSync(statePath(prefix))) {
            chunks = readJson(statePath(prefix)).chunks || [];
            total = chunks.length;
        }
        // The dialogue field is a norm; whether the text obeys it is a separate
        // fact, and the page that invites you to change the norm is where you
        // want to see what changing it would be arguing with.
        res.json({ exists: true, passport, totalChunks: total, speech: speechAdherence(chunks, passport?.dialogue?.marker || null) });
    } catch (e) {
        res.status(500).json({ error: `Не удалось прочитать паспорт: ${e.message}` });
    }
});

app.put('/api/projects/:prefix/passport', (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    if (jobManager.isRunning(prefix)) {
        return res.status(409).json({ error: 'Этап выполняется — редактирование заблокировано' });
    }
    const passport = req.body;
    if (!passport || typeof passport !== 'object' || Array.isArray(passport)) {
        return res.status(400).json({ error: 'Expected a passport object' });
    }
    writeJsonAtomic(passportPath(prefix), { ...passport, updatedAt: new Date().toISOString() });
    res.json({ ok: true });
});

// --- API: glossary ---

app.get('/api/projects/:prefix/glossary', async (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    const gp = glossaryPath(prefix);
    if (!fs.existsSync(gp)) return res.json({ terms: [], counts: [] });

    const terms = readJson(gp);

    // The model's review, if one has been run. It is a separate file because
    // nothing in it is applied automatically — the editor shows each finding on
    // the row it concerns and the human decides.
    let review = null;
    if (fs.existsSync(reviewPath(prefix))) {
        try { review = readJson(reviewPath(prefix)); } catch { review = null; }
    }

    // How many chunks mention each term — helps spotting junk entries
    let counts = [];
    // Hygiene findings per row, from the same code the CLI report uses: entries
    // absent from the text, case duplicates, names nested inside other names,
    // contradictory genders. Editing these is a human's job — the point of
    // showing them here is that the console report cannot be edited from.
    let findings = [];
    // What one whole-book call would cost, so the editor can say so before
    // spending it. The book half is free — the splitter already counted every
    // chunk; the glossary half is estimated from its size rather than tokenised,
    // which would cost more than the answer is worth on every page load.
    let bookTokens = 0;
    if (fs.existsSync(statePath(prefix))) {
        const chunks = readJson(statePath(prefix)).chunks || [];
        bookTokens = chunks.reduce((n, c) => n + (c.tokens || Math.round((c.original || '').length / 4)), 0);
        const lower = chunks.map(c => (c.original || '').toLowerCase());
        counts = terms.map(t => {
            const needle = (t.original || '').toLowerCase();
            if (!needle) return 0;
            return lower.reduce((n, text) => n + (text.includes(needle) ? 1 : 0), 0);
        });
        try {
            const source = chunks.map(c => c.original || '').join('\n');
            findings = glossaryFindings(terms, source);
        } catch (e) {
            // A glossary must stay editable even if the analysis chokes on it.
            console.warn(`[GUI] Glossary analysis failed for ${prefix}: ${e.message}`);
        }
    }

    // Model findings ride in the same per-row array the editor already renders,
    // so one marker and one filter cover both sources.
    let reviewMeta = null;
    if (review) {
        // Resolved against the glossary as it stands, not as it stood: a finding
        // that has been acted on drops out by itself, so editing one entry never
        // costs the review of the others.
        const { byRow, additions, hidden } = glossaryOutstanding(review, terms);
        if (findings.length === terms.length) byRow.forEach((list, i) => findings[i].push(...list));
        const outstanding = byRow.reduce((n, list) => n + list.length, 0) + additions.length;

        // Built field by field on purpose. The review file also holds the
        // findings that failed verification, and spreading the object would put
        // them one careless render away from looking like the rest.
        reviewMeta = {
            generatedAt: review.generatedAt,
            model: review.model,
            total: (review.findings || []).length,
            outstanding,
            hidden,
            // Proposals that belong to no row: terms the book uses and the
            // glossary lacks. They have nowhere to be marked, so they travel
            // separately and the editor lists them on their own.
            additions,
        };
    }

    // 2.7 characters per token, not the 4 that prose gives: the block is JSON
    // with two scripts in it, and punctuation and Cyrillic both tokenise badly.
    // Calibrated against the real tokenizer on this glossary — 28 615 estimated
    // against 28 531 counted. It has to err high rather than low, or the editor
    // offers a call the stage will refuse.
    const glossaryTokens = Math.round(terms.reduce((n, t) =>
        n + String(t.original || '').length + String(t.translation || '').length + String(t.notes || '').length + 40, 0) / 2.7);

    res.json({
        terms, counts, findings,
        // Entries that are inflections of one source word and are translated two
        // ways. Sent per row rather than as a list of groups: the editor shows
        // rows, and a group number on each member is what lets it gather them
        // and put the widest disagreement first. The warning before Stage 2
        // promised this list opens here, and for a while it did not.
        forms: formGroups(terms),
        review: reviewMeta,
        // The editor offers to run the review itself, and both of these decide
        // whether it may: a stage already running, or an estimate that will not
        // fit one call.
        running: jobManager.isRunning(prefix),
        estimate: { bookTokens, glossaryTokens, budget: config.pipeline.bookCallTokenBudget || 250000 },
        bookModel: await bookModelInfo(),
    });
});

// Dismiss a model finding, or bring the dismissed ones back.
//
// A finding now outlives a save, which is the point — but it means one a person
// has judged wrong would return on every load forever. The decision is recorded
// against what the finding says (see findingKey), not where it sat, so it also
// survives the review being run again.
app.post('/api/projects/:prefix/glossary-review/dismiss', (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    const rp = reviewPath(prefix);
    if (!fs.existsSync(rp)) return res.status(404).json({ error: 'No glossary review for this project' });

    const { key, restoreAll } = req.body || {};
    let review;
    try { review = readJson(rp); }
    catch (e) { return res.status(500).json({ error: `Could not read the review: ${e.message}` }); }

    const dismissed = new Set((review.dismissed || []).map(k => String(k).toLowerCase()));
    if (restoreAll) {
        dismissed.clear();
    } else {
        if (typeof key !== 'string' || !key.trim()) return res.status(400).json({ error: 'key is required' });
        dismissed.add(key.trim().toLowerCase());
    }
    review.dismissed = [...dismissed];
    writeJsonAtomic(rp, review);
    res.json({ ok: true, dismissed: review.dismissed.length });
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

    if (!['1', 'passport', 'glossary', '2', 'review', 'export'].includes(String(stage))) {
        return res.status(400).json({ error: 'stage must be 1, passport, glossary, 2, review or export' });
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

/**
 * Decide a finding from the whole-book review.
 *
 * "accept" queues the advice on the chunk the quote was found in; the next
 * Stage 2 run fixes that chunk with the advice as its instruction and clears it
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
    if (!key || !['accept', 'dismiss', 'undo', 'handled', 'queueTerm'].includes(action)) {
        return res.status(400).json({ error: 'Expected { key, action: accept|dismiss|undo|handled|queueTerm }' });
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

    // Dealt with, as opposed to wrong. Kept in its own list so the dismissals
    // stay usable as evidence about how far a finding can be trusted.
    if (action === 'handled') {
        review.handled = [...new Set([...(review.handled || []), String(key).toLowerCase()])];
        writeJsonAtomic(file, review);
        return res.json({ ok: true, handled: review.handled.length });
    }

    // Fixing a glossary entry changes nothing already translated. This queues the
    // chunks that use the term, so the correction reaches the book — offered
    // rather than done automatically, because on Morphotrophic one of these terms
    // sits in 21 chunks of 169 and that is a real bill.
    if (action === 'queueTerm') {
        if (finding.scope !== 'glossary' || !finding.term) {
            return res.status(400).json({ error: 'This finding names no glossary entry, so there is nothing to look for' });
        }
        const k = String(key).toLowerCase();
        const affected = chunksUsingTerm(state.chunks || [], finding.term);
        for (const i of affected) {
            const chunk = state.chunks[i];
            chunk.advice = (chunk.advice || []).filter(a => a.key !== k);
            chunk.advice.push({ key: k, issue: finding.issue, advice: finding.problem, quote: finding.quote, term: finding.term });
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
 * Hand the whole-book prompt over so it can be run somewhere else.
 *
 * The per-minute input quota, not the context window, is what refuses these
 * calls; a web console is a different quota surface with a far bigger window.
 * `original=1` pairs each chunk with its source, which no free tier would take
 * and a million-token window will — that is the manual route's own advantage,
 * not merely a way around a limit.
 */
app.get('/api/projects/:prefix/translation-review/prompt', (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    const withOriginal = req.query.original === '1';
    let state;
    try { state = new ProjectState(ROOT, prefix); state.load(); }
    catch (e) { return res.status(500).json({ error: e.message }); }

    let built;
    try { built = buildTranslationReviewPrompt(state, { withOriginal }); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    // The fingerprint travels inside the text, because it has to come back with
    // an answer a person carried by hand and there is nowhere else to put it.
    const text = `${built.system}\n\n${built.user}\n\n` +
        `<!-- prozetta: ${prefix} · fingerprint ${built.fingerprint} · ` +
        `${built.withOriginal ? 'bilingual' : 'translation only'} · ~${built.tokens.total} tokens -->\n`;

    if (req.query.download === '1') {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition',
            `attachment; filename="review-prompt-${encodeURIComponent(prefix)}${withOriginal ? '-bilingual' : ''}.txt"`);
        return res.send(text);
    }
    res.json({
        ok: true,
        fingerprint: built.fingerprint,
        tokens: built.tokens,
        withOriginal: built.withOriginal,
        budget: built.budget,
        warnings: built.warnings,
        chars: text.length,
        text,
    });
});

/** Take an answer obtained elsewhere through exactly the checks an API one gets. */
app.post('/api/projects/:prefix/translation-review/answer', (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
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
        return res.status(400).json({ error: `No JSON found in the answer: ${e.message}. ` +
            `Paste the reply whole, including its \`\`\`json block.` });
    }

    try {
        const { review, findings, rejected, notes } = applyTranslationReview(state, raw, {
            model: String(model || '').trim() || 'unnamed (run by hand)',
            source: 'manual',
            fingerprint: fp,
            withOriginal: !!withOriginal,
            answerText: answer,
        });
        res.json({ ok: true, returned: review.returned, findings: findings.length, rejected, notes });
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
    // After a GUI restart the in-memory log is empty — restore history from
    // the persistent <prefix>_run.log instead.
    if (job.log.length === 0) {
        const tail = runLogTail(prefix);
        if (tail.length > 0) return res.json({ ...job, log: tail, fromFile: true });
    }
    res.json(job);
});

// Revert the whole project to its post-Stage-1 state: drop what Stage 2 wrote so
// it can be re-run from scratch, and leave the rest of the chunk alone. Shares
// withoutTranslation() with src_v4/tools/reset_to_stage1.js — the two used to
// carry the same list separately, and the same defect with it. Backs up first.
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
    const backupPath = path.join(projectDir(ROOT, prefix), 'state_before_reset.json.bak');
    fs.copyFileSync(file, backupPath);

    let modified = 0;
    state.chunks = (state.chunks || []).map(chunk => {
        if (chunk.translation || chunk.history || chunk.translation_status) modified++;
        return withoutTranslation(chunk);
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

    // The state is kept outside the folder about to go, so a delete can still be
    // undone by hand.
    const backup = path.join(ROOT, `${prefix}_project_state.deleted.bak`);
    try { fs.copyFileSync(sp, backup); } catch { /* best effort */ }

    // The whole folder, rather than a list of the files in it. The list was
    // written by hand and went stale twice — once missing the passport, once the
    // glossary review — quietly leaving files behind after a delete.
    const removed = [];
    const dir = projectDir(ROOT, prefix);
    try {
        for (const f of fs.readdirSync(dir)) removed.push(f);
        fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
        return res.status(500).json({ error: `Could not remove ${dir}: ${e.message}` });
    }

    // The assembled translation lives in txt/, with the source the person put
    // there — so it is named explicitly rather than swept up with the folder.
    for (const f of [path.join(TXT_DIR, outputFileName(prefix)),
                     path.join(TXT_DIR, outputFileName(prefix, null, 'fb2'))]) {
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

const MODEL_GROUPS = ['logic_model', 'google_model', 'groq_model', 'book_model'];
const PROVIDERS = ['local', 'google', 'groq'];

/**
 * The large model's settings as the pipeline will resolve them: its own block
 * over the provider it names, with unsaved edits from the settings form on top.
 * Mirrors LLMClient.getBookSettings — the two must agree, or a green test would
 * mean nothing.
 *
 * @returns {{effective: object|null, provider: string}} effective is null when
 *   the provider is not one this build knows.
 */
function bookEffective(cfg, pending = {}) {
    const book = { ...(cfg.book_model || {}), ...pending };
    const provider = String(book.provider || cfg.activeProvider || 'local');
    if (!PROVIDER_CONFIG_KEY[provider] && provider !== BOOK_OWN_PROVIDER) {
        return { effective: null, provider };
    }
    const base = provider === BOOK_OWN_PROVIDER ? {} : (cfg[PROVIDER_CONFIG_KEY[provider]] || {});
    const effective = { ...base };
    for (const [key, value] of Object.entries(book)) {
        if (key === 'provider' || key === 'enabled') continue;
        if (value !== undefined && value !== null && value !== '') effective[key] = value;
    }
    return { effective, provider };
}

/** What the interface needs to decide whether to offer whole-book passes. */
async function bookModelInfo() {
    try {
        const cfg = await loadEffectiveConfig();
        const { effective, provider } = bookEffective(cfg);
        return {
            enabled: cfg.book_model?.enabled !== false,
            provider,
            modelName: effective?.modelName || null,
        };
    } catch {
        return { enabled: false, provider: null, modelName: null };
    }
}

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
    const { provider, values, group } = req.body || {};
    const isBook = group === 'book_model';
    if (!isBook && !PROVIDERS.includes(provider)) {
        return res.status(400).json({ error: `Invalid provider: ${provider}` });
    }

    let cfg;
    try { cfg = await loadEffectiveConfig(); } catch (e) { return res.status(500).json({ error: e.message }); }

    // The large model is tested the way it will actually be called: its own
    // block laid over whichever provider it names, so a test that passes means
    // a book pass will connect — testing the provider card alone would not,
    // since book_model may override the model or the address.
    const { effective, provider: bookProvider } = isBook
        ? bookEffective(cfg, values || {})
        : { effective: null, provider: null };
    if (isBook && !effective) {
        return res.status(400).json({ error: `Invalid provider in book_model: ${bookProvider}` });
    }

    const base = isBook ? effective : (cfg[PROVIDER_CONFIG_KEY[provider]] || {});
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
        const client = createRawClient(isBook ? bookProvider : provider, conf);
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

// Google Free-tier rate limits (RPM / TPM / RPD). These are NOT in the ListModels
// API — they are tier-dependent and change over time, so this is a hand-curated
// snapshot keyed by model id. Bump GOOGLE_FREE_TIER_AS_OF when you refresh it
// (source: https://ai.google.dev/gemini-api/docs/rate-limits + AI Studio).
const GOOGLE_FREE_TIER_AS_OF = '2026-07-24';
// `tpm` here is the documented TOTAL per-minute allowance, and it is NOT what
// refuses a whole-book call. There is a separate, lower quota over input alone —
// GenerateContentInputTokensPerModelPerMinute-FreeTier. Measured on
// gemini-3.7-flash: 167,852 input tokens went through and ~195,000 was refused,
// while this table says 250,000. pipeline.bookCallTokenBudget is the number that
// governs those calls; this one only describes the tier in Settings.
const GOOGLE_FREE_TIER_LIMITS = {
    'gemini-2.5-flash':              { rpm: 5,  tpm: 250000, rpd: 20 },
    'gemini-2.5-flash-lite':         { rpm: 10, tpm: 250000, rpd: 20 },
    'gemini-3-flash':                { rpm: 5,  tpm: 250000, rpd: 20 },
    'gemini-3-flash-preview':        { rpm: 5,  tpm: 250000, rpd: 20 },
    'gemini-3.5-flash':              { rpm: 5,  tpm: 250000, rpd: 20 },
    'gemini-3.6-flash':              { rpm: 5,  tpm: 250000, rpd: 20 },
    'gemini-3.7-flash':              { rpm: 5,  tpm: 250000, rpd: 20 },
    'gemini-3.1-flash-lite':         { rpm: 15, tpm: 250000, rpd: 500 },
    'gemini-3.1-flash-lite-preview': { rpm: 15, tpm: 250000, rpd: 500 },
    'gemini-3.5-flash-lite':         { rpm: 15, tpm: 250000, rpd: 500 },
    'gemma-4-31b-it':                { rpm: 30, tpm: 16000,  rpd: 14400 },
    'gemma-4-26b-a4b-it':            { rpm: 30, tpm: 16000,  rpd: 14400 },
};

// List the Google (Gemini) models available to the given key, straight from the
// ListModels REST endpoint. Uses the apiKey from the form if present, else the
// saved one (same rule as /test). Per-model token limits come live from the API;
// the Free-tier rate limits (RPM/TPM/RPD) are overlaid from the curated table
// above, since the API doesn't expose them. The UI also links to the AI Studio
// dashboard for authoritative rate/usage numbers.
app.post('/api/config/google/models', async (req, res) => {
    let cfg;
    try { cfg = await loadEffectiveConfig(); } catch (e) { return res.status(500).json({ error: e.message }); }

    const saved = cfg.google_model || {};
    const raw = req.body?.apiKey;
    const apiKey = (typeof raw === 'string' && raw.trim() !== '') ? raw.trim() : saved.apiKey;
    if (!apiKey) return res.status(400).json({ error: 'No API key set for Google' });

    try {
        const collected = [];
        let pageToken = '';
        // The endpoint paginates (default 50/page); follow nextPageToken for the rest.
        for (let page = 0; page < 20; page++) {
            const url = new URL('https://generativelanguage.googleapis.com/v1beta/models');
            url.searchParams.set('key', apiKey);
            url.searchParams.set('pageSize', '1000');
            if (pageToken) url.searchParams.set('pageToken', pageToken);

            const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
            if (!r.ok) {
                let msg = `HTTP ${r.status}`;
                try { const j = await r.json(); msg = j.error?.message || msg; } catch { /* keep status */ }
                return res.status(502).json({ error: msg });
            }
            const data = await r.json();
            for (const m of data.models || []) collected.push(m);
            pageToken = data.nextPageToken || '';
            if (!pageToken) break;
        }

        // Keep only models usable for chat translation; strip the "models/" prefix.
        // All fields below already come back in the ListModels payload — no extra
        // request. Rate limits/usage still aren't here (dashboard link covers that).
        const models = collected
            .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
            .map(m => {
                const methods = m.supportedGenerationMethods || [];
                const name = String(m.name || '').replace(/^models\//, '');
                return {
                    name,
                    displayName: m.displayName || '',
                    description: m.description || '',
                    inputTokenLimit: m.inputTokenLimit ?? null,
                    outputTokenLimit: m.outputTokenLimit ?? null,
                    temperature: m.temperature ?? null,
                    maxTemperature: m.maxTemperature ?? null,
                    thinking: !!m.thinking,
                    caching: methods.includes('createCachedContent'),
                    batch: methods.includes('batchGenerateContent'),
                    freeLimits: GOOGLE_FREE_TIER_LIMITS[name] || null,
                };
            })
            .sort((a, b) => a.name.localeCompare(b.name));

        res.json({ ok: true, models, freeAsOf: GOOGLE_FREE_TIER_AS_OF });
    } catch (e) {
        const msg = e.name === 'TimeoutError' ? 'Google API timed out' : (e.message || String(e));
        res.status(502).json({ error: msg });
    }
});

app.listen(PORT, '127.0.0.1', () => {
    console.log(`[GUI] prozetta GUI running at http://127.0.0.1:${PORT}`);
});
