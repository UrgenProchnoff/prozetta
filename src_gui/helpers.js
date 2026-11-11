/**
 * What the route groups share: where a project keeps its files, how they are
 * read and written, and what the interface is told about a project.
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { jobManager, clockTime } from './jobs.js';
import { PROVIDER_CONFIG_KEY, BOOK_OWN_PROVIDER } from '../src_v4/core/llm_client.js';
import { projectPaths, exportFileName } from '../src_v4/core/paths.js';
import { handEdited } from '../src_v4/core/passport.js';
import { dominantMarker, deviatingChunks, adherence } from '../src_v4/core/dialogue.js';
import { inflectionGroups } from '../src_v4/core/glossary_forms.js';
import { entryRegex } from '../src_v4/core/text_stats.js';
import { normalize as normalizeUsage } from '../src_v4/core/usage_tracker.js';
import { writeFileAtomic } from '../src_v4/utils/atomic_write.js';
import { outstandingFindings as reviewOutstanding, adviceQueue, spanIn } from '../src_v4/core/translation_review.js';
import { ROOT, TXT_DIR, CONFIG_PATH } from './app.js';

// --- Helpers ---

// A project prefix is derived from the book's filename and becomes part of
// on-disk filenames (`<prefix>_project_state.json`) as well as a URL path
// segment and the Content-Disposition filename on download. So it must stay a
// single, safe path component: we allow spaces and Unicode letters (Cyrillic,
// etc.), but reject path separators, traversal and characters that are unsafe
// in filenames or HTTP headers.
export const PREFIX_FORBIDDEN_RE = /[\\/:*?"<>|\x00-\x1f]/;

export function isValidPrefix(prefix) {
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
export const statePath = (prefix) => paths(prefix).state;
export const glossaryPath = (prefix) => paths(prefix).glossary;
export const reviewPath = (prefix) => paths(prefix).review;
export const transReviewPath = (prefix) => paths(prefix).translationReview;

export const passportPath = (prefix) => paths(prefix).passport;
export const structurePath = (prefix) => paths(prefix).structure;
const runLogPath = (prefix) => paths(prefix).log;

// Tail of the persistent per-project log written by src_v4 (survives GUI
// restarts, unlike the in-memory job log). Written the way live SSE output is:
// the UTC timestamp becomes local "14:05:09" and the level goes; "=== RUN ...
// ===" separators stay as they are.
const LOG_LINE_META_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) (?:INFO|WARN|ERROR) /;
export function runLogTail(prefix, maxLines = 500) {
    try {
        const raw = fs.readFileSync(runLogPath(prefix), 'utf-8');
        return raw.split('\n')
            .filter(l => l.trim())
            .slice(-maxLines)
            .map(l => l.replace(LOG_LINE_META_RE, (_, ts) => `${clockTime(new Date(ts))} `));
    } catch {
        return [];
    }
}

// The assembled output filename for a project — see exportFileName. `metadata`
// is the project's, read from its state when the caller does not have it; the
// suffix defaults to "rus" for legacy projects that never recorded one.
export function outputFileName(prefix, metadata, ext = 'txt') {
    let meta = metadata;
    if (!meta) {
        try { meta = readJson(statePath(prefix)).metadata || {}; } catch { meta = {}; }
    }
    return exportFileName(prefix, { suffix: meta.langSuffix || 'rus', clone: !!meta.clonedFrom }, ext);
}

// The book cover lives in the project folder as cover.jpg|png.
export const coverPath = (prefix, ext) => paths(prefix).cover(ext);

// Find the existing cover file for a project, or null.
export function findCover(prefix) {
    for (const ext of ['jpg', 'png']) {
        const p = coverPath(prefix, ext);
        if (fs.existsSync(p)) return { path: p, ext, mime: ext === 'png' ? 'image/png' : 'image/jpeg' };
    }
    return null;
}

export function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

/** The project's glossary, or an empty one if there is none or it cannot be read. */
export function readGlossaryOrEmpty(prefix) {
    try {
        const g = readJson(glossaryPath(prefix));
        return Array.isArray(g) ? g : [];
    } catch { return []; }
}

export function writeJsonAtomic(file, data) {
    writeFileAtomic(file, JSON.stringify(data, null, 2));
}

export function validPrefix(req, res) {
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
export function chunksUsingTerm(chunks, term, glossary = []) {
    // Matched as the cheat sheet will match it, so the count is the work the
    // correction will actually cause: a name with its case.
    const key = String(term).trim().toLowerCase();
    const entry = glossary.find(t => String(t?.original || '').trim().toLowerCase() === key);
    const re = entryRegex({ original: String(term), type: entry?.type }, true);
    const out = [];
    (chunks || []).forEach((c, i) => { if (c?.original && re.test(c.original)) out.push(i); });
    return out;
}

export function speechAdherence(chunks, expected) {
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
export function formGroups(terms) {
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

// A chunk counts as extracted if the extraction marked it done — including 'blocked'
// (the content filter refused the text; extraction skipped it permanently). Older
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

export function projectSummary(prefix) {
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
            // which are about extraction: the same chunk can be refused by one model
            // at extraction and by another at translation.
            // Whatever the status: a chunk that already had a translation keeps
            // it when a model refuses to rework it, and only this says so.
            translationBlockedBy: c.translation_blocked_by || null,
            // Translator and reviewer could not agree (repeated rejection of a
            // fresh draft) — the loop stopped instead of burning budget, and a
            // human should settle it.
            disputed: !!c.dispute,
            // Advice accepted from the whole-book review and waiting for the next
            // translation run. Work outstanding on a chunk that otherwise looks done,
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
            const { open, done, hidden, dismissed, total } = reviewOutstanding(r, chunks);
            // For a glossary finding that names its entry: how many chunks use
            // that term. Fixing the glossary changes nothing already translated,
            // so this is the size of the work the finding actually implies, and
            // it has to be on screen before the button is pressed.
            let glossary = null;
            for (const f of open) {
                const inText = passageWithBreaks(chunks[f.chunk]?.translation, f);
                if (inText) f.inText = inText;
                if (f.scope !== 'glossary' || !f.term) continue;
                glossary = glossary || readGlossaryOrEmpty(prefix);
                f.affects = chunksUsingTerm(chunks, f.term, glossary).length;
            }
            translationReview = {
                generatedAt: r.generatedAt || null,
                model: r.model || null,
                // Which review this is; null for one saved before reviews were
                // counted, whose place in the sequence nobody recorded.
                round: r.round ?? null,
                score: r.score ?? null,
                summary: r.summary || null,
                returned: r.returned ?? null,
                rejected: r.rejected || null,
                open, done, hidden, total,
                // The dismissed ones, so they can be read and taken back. Trimmed
                // to what identifies a finding and what it objected to: the rest
                // comes with it when it returns to the open list, and this list
                // rides along on every summary the monitor asks for.
                dismissed: dismissed.map(f => ({
                    key: f.key, chunk: f.chunk, scope: f.scope, rank: f.rank,
                    issue: f.issue, quote: f.quote, problem: f.problem,
                })),
            };
        } catch { translationReview = { broken: true }; }
    }

    let glossaryReview = null;
    if (fs.existsSync(reviewPath(prefix))) {
        try {
            const r = readJson(reviewPath(prefix));
            glossaryReview = {
                findings: (r.findings || []).length, generatedAt: r.generatedAt || null,
                round: r.round ?? null, score: r.score ?? null,
            };
        } catch { glossaryReview = { broken: true }; }
    }

    return {
        prefix,
        // Usage recorded before thinking was counted as output is shown the
        // way it is counted now, without waiting for the next run to resave it.
        metadata: state.metadata?.usage
            ? { ...state.metadata, usage: { ...state.metadata.usage, ...normalizeUsage(state.metadata.usage) } }
            : (state.metadata || {}),
        total: chunks.length,
        statuses,
        extracted,
        glossaryCount,
        glossaryForms,
        glossaryReview,
        translationReview,
        // Beside the review rather than inside it: advice outlives the review it
        // came from, and a queue nobody can see is a queue nobody can empty.
        adviceQueue: adviceQueue(chunks),
        passport,
        dialogue,
        running: jobManager.isRunning(prefix),
        // Which stage, not merely that one is going. The pipeline showed seven
        // identical steps and none of them said "you are here".
        runningStage: runningStage(prefix),
        // The assembled book, if there is one, and whether the translation has
        // moved since. The export step used to be permanently unfinished, which
        // read as "you are never done".
        exported: exportedState(prefix, state),
        chunks: chunkList
    };
}

/** The `--stage=` of the job running for a project, or null. */
function runningStage(prefix) {
    if (!jobManager.isRunning(prefix)) return null;
    const args = jobManager.getJob(prefix)?.args || [];
    const arg = args.find(a => String(a).startsWith('--stage='));
    return arg ? String(arg).slice('--stage='.length) : null;
}

/**
 * The exported book: when it was written, and whether the translation has
 * changed since. `stale` is what a person actually wants to know — the file
 * exists, but does it still match what is on screen?
 */
function exportedState(prefix, state) {
    const file = path.join(TXT_DIR, outputFileName(prefix, state.metadata || {}));
    if (!fs.existsSync(file)) return null;
    try {
        const at = fs.statSync(file).mtime.toISOString();
        const changed = state.metadata?.updatedAt || null;
        return { at, stale: !!(changed && changed > at) };
    } catch { return null; }
}

// Resolve the --file argument for a project. On an existing project the file
// only identifies the prefix; on a fresh one extraction/translation read it to build chunks.
export function resolveSourceFile(prefix) {
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

/**
 * The quoted passage as the translation has it now, when it crosses a line
 * break — otherwise null, and the quote is shown as the model wrote it.
 *
 * A model writes its quotes on one line, and then judges the text by them: a
 * reply already on a line of its own was reported as run into the narration.
 * Shown with its breaks, a finding like that answers itself.
 */
export function passageWithBreaks(text, f) {
    const at = spanIn(text, f);
    if (!at) return null;
    const passage = String(text).slice(at[0], at[1]);
    return passage.includes('\n') ? passage : null;
}

/**
 * The large model's settings as the pipeline will resolve them: its own block
 * over the provider it names, with unsaved edits from the settings form on top.
 * Mirrors LLMClient.getBookSettings — the two must agree, or a green test would
 * mean nothing.
 *
 * @returns {{effective: object|null, provider: string}} effective is null when
 *   the provider is not one this build knows.
 */
export function bookEffective(cfg, pending = {}) {
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
export async function bookModelInfo() {
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

// Load the effective config fresh (defaults merged with overrides). Cache-bust
// the dynamic import so edits are reflected without restarting the server.
export async function loadEffectiveConfig() {
    const url = pathToFileURL(CONFIG_PATH).href + `?t=${Date.now()}`;
    const mod = await import(url);
    return mod.default;
}
