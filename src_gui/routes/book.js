/** The finished book: title and author, cover, FB2 structure and the download. */
import express from 'express';
import fs from 'fs';
import path from 'path';
import { jobManager } from '../jobs.js';
import { createRawClient, PROVIDER_CONFIG_KEY, isTransientServerError, failureSummary } from '../../src_v4/core/llm_client.js';
import { assembleBookText, assembleBookFb2 } from '../../src_v4/core/book_assembler.js';
import { structureCandidates, matchStructure, outline, loadStructure, headingLookup, buildStructurePrompt, applyStructureAnswer } from '../../src_v4/core/book_structure.js';
import { getPrompts } from '../../src_v4/prompts.js';
import { extractJson } from '../../src_v4/utils/parsers.js';
import { writeFileAtomic } from '../../src_v4/utils/atomic_write.js';
import config from '../../src_v4/config.js';
import { TXT_DIR, app } from '../app.js';
import { statePath, passportPath, structurePath, outputFileName, coverPath, findCover, readJson, writeJsonAtomic, validPrefix, bookEffective, loadEffectiveConfig } from '../helpers.js';

// --- API: book metadata (title/author for export) + cover ---

app.get('/api/projects/:prefix/book-meta', (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    let state;
    try { state = readJson(statePath(prefix)); } catch { return res.status(404).json({ error: 'Project not found' }); }
    const book = state.metadata?.book || {};
    // What the passport proposed, so the page can say where a title came from.
    let proposed = null;
    try { proposed = fs.existsSync(passportPath(prefix)) ? readJson(passportPath(prefix)).book || null : null; } catch { /* no hint */ }
    res.json({
        proposed,
        title: book.title || '',
        author: book.author || '',
        annotation: book.annotation || '',
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

    const { title, author, annotation } = req.body || {};
    state.metadata = state.metadata || {};
    state.metadata.book = {
        ...(state.metadata.book || {}),
        title: String(title ?? '').trim().slice(0, 300),
        author: String(author ?? '').trim().slice(0, 300),
        // Кладётся в <annotation> абзацами по строкам, поэтому переносы живые.
        annotation: String(annotation ?? '').replace(/\r\n?/g, '\n').trim().slice(0, 3000),
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
    writeFileAtomic(coverPath(prefix, ext), buf);
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

// --- API: book structure (headings for FB2) ---
//
// Which short lines of the translation are headings, and of what level, marked
// by the large model from the lines alone — not the book. Kept in structure.json
// and read by the FB2 export; without it the export guesses by keyword.

const STRUCTURE_ATTEMPTS = 4;

function structureReport(prefix, chunks) {
    const candidates = structureCandidates(chunks);
    const structure = loadStructure(structurePath(prefix));
    const { byKey, matched, lost, unmarked } = matchStructure(structure, candidates);
    return {
        candidates: candidates.length,
        tokens: candidates.length
            ? buildStructurePrompt(chunks, getPrompts(config.translation.promptLang)).tokens.total : 0,
        marked: !!structure,
        model: structure?.model || null,
        generatedAt: structure?.generatedAt || null,
        matched, lost,
        // Only meaningful once something was asked: before that every line is new.
        unmarked: structure ? unmarked : 0,
        outline: structure ? outline(candidates, byKey) : [],
    };
}

app.get('/api/projects/:prefix/structure', (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    let state;
    try { state = readJson(statePath(prefix)); } catch { return res.status(404).json({ error: 'Project not found' }); }
    res.json(structureReport(prefix, state.chunks || []));
});

app.post('/api/projects/:prefix/structure', async (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    if (jobManager.isRunning(prefix)) {
        return res.status(409).json({ error: 'Этап выполняется — разметка заблокирована' });
    }
    let state;
    try { state = readJson(statePath(prefix)); } catch { return res.status(404).json({ error: 'Project not found' }); }
    const chunks = state.chunks || [];
    if (!structureCandidates(chunks).length) return res.status(409).json({ error: 'No lines that could be headings — nothing to mark' });

    let cfg;
    try { cfg = await loadEffectiveConfig(); } catch (e) { return res.status(500).json({ error: e.message }); }
    if (cfg.book_model?.enabled === false) {
        return res.status(409).json({ code: 'book_off', error: 'The large model is switched off (Settings → Large model)' });
    }
    const { effective, provider } = bookEffective(cfg);
    if (!effective) return res.status(400).json({ error: `Invalid provider in book_model: ${provider}` });
    const built = buildStructurePrompt(chunks, getPrompts(cfg.translation?.promptLang));

    try {
        // Picking headings out of a list is light work. At the book profile's
        // usual "high" even "Reply with just: OK" took 217 s, and the longer a
        // request hangs on a busy model the likelier it ends in "fetch failed".
        const client = createRawClient(provider, { ...effective, thinkingLevel: 'low' });
        const ask = () => Promise.race([
            client.invoke([
                { role: 'system', content: built.system },
                { role: 'user', content: built.user },
            ]),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 600000)),
        ]);
        // The raw client has none of the pipeline's retries, and a "503 high
        // demand" is exactly what clears if waited out: measured on the first
        // press, the key was fine and Google was simply busy.
        let result;
        for (let attempt = 1; ; attempt++) {
            try { result = await ask(); break; }
            catch (e) {
                if (attempt >= STRUCTURE_ATTEMPTS || !isTransientServerError(e)) throw e;
                console.warn(`[GUI] Structure for "${prefix}": ${failureSummary(e)} — retrying in ${attempt * 20}s (${attempt}/${STRUCTURE_ATTEMPTS - 1}).`);
                await new Promise(r => setTimeout(r, attempt * 20000));
            }
        }
        const content = result?.content;
        const text = typeof content === 'string' ? content
            : Array.isArray(content) ? content.map(p => p?.text || '').join('') : '';
        const { marks } = applyStructureAnswer(chunks, extractJson(text), structurePath(prefix), {
            model: effective.modelName, fingerprint: built.fingerprint,
        });
        console.log(`[GUI] Structure for "${prefix}": ${marks.length} heading(s) among ${built.candidates.length} candidate line(s), by ${effective.modelName}.`);
        res.json(structureReport(prefix, chunks));
    } catch (e) {
        res.status(502).json({ error: failureSummary(e) || String(e) });
    }
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
            // The model's marks when the book has been marked; keywords otherwise.
            headingAt: headingLookup(chunks, loadStructure(structurePath(prefix))) || undefined,
            title: book.title || prefix,
            author: book.author || '',
            annotation: book.annotation || '',
            langSuffix: state.metadata?.langSuffix,
            modelName,
            cover,
        });
        const outName = outputFileName(prefix, state.metadata || {}, 'fb2');
        try { writeFileAtomic(path.join(TXT_DIR, outName), xml); } catch { /* best effort */ }
        res.setHeader('Content-Type', 'application/x-fictionbook+xml; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${outName}"`);
        return res.send(xml);
    }

    const { text } = assembleBookText(chunks, modelName);

    const outName = outputFileName(prefix, state.metadata || {});

    // Persist the assembled file too (so the CLI/txt dir stays in sync).
    try { writeFileAtomic(path.join(TXT_DIR, outName), text); } catch { /* best effort */ }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${outName}"`);
    res.send(text);
});
