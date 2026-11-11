/** Projects as a whole: the list, a new upload, the summary, reset, clone and delete. */
import express from 'express';
import fs from 'fs';
import path from 'path';
import { jobManager } from '../jobs.js';
import { projectDir, ensureProjectDir, listProjects, PROJECTS_DIR } from '../../src_v4/core/paths.js';
import { withoutTranslation } from '../../src_v4/core/state_manager.js';
import { writeFileAtomic } from '../../src_v4/utils/atomic_write.js';
import { ROOT, TXT_DIR, app } from '../app.js';
import { PREFIX_FORBIDDEN_RE, isValidPrefix, statePath, outputFileName, coverPath, findCover, readJson, writeJsonAtomic, validPrefix, projectSummary, bookModelInfo, loadEffectiveConfig } from '../helpers.js';

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
    const outputs = new Set(projects.map(p => outputFileName(p.prefix, p.metadata || {})));
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
    writeFileAtomic(target, decoded.text.replace(/^\uFEFF/, ''));
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

// Revert the whole project to its post-extraction state: drop what the translation wrote so
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
// skipped on the clone's extraction); only consolidation + translation re-run for the
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
        // Everything but the translation, through the same deny-list a reset
        // uses. This was an allow-list of three fields, and it dropped what the
        // rest of the pipeline had added since: `tokens`, so every budget check
        // on the clone recounted the whole book or fell back to guessing, and
        // `blocked_by`, so chunks a model had refused at extraction were sent to
        // that same model again. See TRANSLATION_FIELDS in state_manager.js.
        chunks: (src.chunks || []).map(withoutTranslation),
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

    // A new project, so its folder does not exist yet. Since projects moved into
    // folders of their own, nothing here created it, and every clone failed
    // with ENOENT before writing a byte.
    ensureProjectDir(ROOT, newPrefix);
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

    // The exported files are named after the project's language suffix, and the
    // suffix is in the state — so the names are worked out now, while there is
    // a state to read. Asked after the folder had gone, outputFileName fell back
    // to "rus", and a book exported as book_eng.txt, or a clone's book_de.fb2,
    // stayed behind in txt/ after its project was deleted.
    let meta = {};
    try { meta = readJson(sp).metadata || {}; } catch { /* unreadable — fall back to the default suffix */ }
    // The source is never an output, whatever the names say. They can coincide:
    // a book called Foo_rus.txt translated with the suffix "rus" exports to
    // Foo_rus.txt, and deleting the project would then delete the book. A
    // project that is not a clone was made from txt/<prefix>.txt, which covers
    // the ones old enough to have no sourceFile recorded; a clone was made from
    // its original's book, and its own <prefix>.txt is a real export.
    const sources = [meta.sourceFile && path.resolve(ROOT, meta.sourceFile),
                     !meta.clonedFrom && path.join(TXT_DIR, `${prefix}.txt`)].filter(Boolean);
    const outputs = ['txt', 'fb2']
        .map(ext => path.join(TXT_DIR, outputFileName(prefix, meta, ext)))
        .filter(f => !sources.includes(f));

    // The state is kept outside the folder about to go, so a delete can still be
    // undone by hand — but beside that folder, not in the repository root. It
    // used to land there under the flat name every project file had before they
    // moved into projects/, and it was the last thing still writing to the root:
    // delete three books and three multi-megabyte .bak files appear next to
    // README.md. projects/ is gitignored and listProjects only counts
    // directories holding a state.json, so a file here is out of the way without
    // being out of reach.
    const backup = path.join(ROOT, PROJECTS_DIR, `${prefix}.deleted.bak`);
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
    for (const f of outputs) {
        try { if (fs.existsSync(f)) { fs.unlinkSync(f); removed.push(path.basename(f)); } } catch { /* best effort */ }
    }

    res.json({ ok: true, removed });
});
