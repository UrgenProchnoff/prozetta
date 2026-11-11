/** The glossary editor: the entries with their evidence, review findings, import from another book. */
import fs from 'fs';
import path from 'path';
import { jobManager } from '../jobs.js';
import { createRawClient, PROVIDER_CONFIG_KEY } from '../../src_v4/core/llm_client.js';
import { planImport } from '../../src_v4/core/glossary_import.js';
import { glossaryFindings } from '../../src_v4/tools/glossary_hygiene.js';
import { personGroups, MAX_NOTE_CHARS } from '../../src_v4/core/glossary_links.js';
import { getPrompts } from '../../src_v4/prompts.js';
import { outstandingFindings as glossaryOutstanding } from '../../src_v4/core/glossary_review.js';
import { listProjects } from '../../src_v4/core/paths.js';
import { entryRegex } from '../../src_v4/core/text_stats.js';
import { extractFromTags } from '../../src_v4/utils/parsers.js';
import config from '../../src_v4/config.js';
import { ROOT, app } from '../app.js';
import { isValidPrefix, statePath, glossaryPath, reviewPath, readJson, writeJsonAtomic, validPrefix, formGroups, resolveSourceFile, bookModelInfo, loadEffectiveConfig } from '../helpers.js';

// --- API: glossary ---

// --- API: glossary import from another book of the series ---
//
// Read-only: the editor applies the plan in memory and the person saves it with
// the usual button, so the unsaved-changes guard covers an import like any edit.

function projectTargetLanguage(prefix) {
    try { return readJson(statePath(prefix)).metadata?.targetLanguage || config.translation.targetLanguage; }
    catch { return config.translation.targetLanguage; }
}

/** This book's original text: its chunks, or the source file before it is split. */
function projectSourceText(prefix) {
    try {
        const chunks = readJson(statePath(prefix)).chunks || [];
        if (chunks.length) return chunks.map(c => c.original || '').join('\n');
    } catch { /* fall back to the file */ }
    const file = resolveSourceFile(prefix);
    if (!file) return '';
    try { return fs.readFileSync(path.isAbsolute(file) ? file : path.join(ROOT, file), 'utf-8'); } catch { return ''; }
}

app.get('/api/projects/:prefix/glossary/import-sources', (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    // Another language's glossary renders the names into that language, which is
    // never what a series wants carried across.
    const lang = projectTargetLanguage(prefix);
    const sources = [];
    for (const other of listProjects(ROOT)) {
        if (other === prefix || !fs.existsSync(glossaryPath(other))) continue;
        if (projectTargetLanguage(other) !== lang) continue;
        let terms = 0;
        try { const g = readJson(glossaryPath(other)); terms = Array.isArray(g) ? g.length : 0; } catch { continue; }
        if (terms) sources.push({ prefix: other, terms });
    }
    res.json({ language: lang, sources });
});

app.get('/api/projects/:prefix/glossary/import-preview', (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    const from = String(req.query.from || '');
    if (!isValidPrefix(from) || from === prefix || !fs.existsSync(glossaryPath(from))) {
        return res.status(400).json({ error: 'Unknown source project' });
    }
    let incoming, current = [];
    try { incoming = readJson(glossaryPath(from)); } catch (e) { return res.status(500).json({ error: e.message }); }
    if (fs.existsSync(glossaryPath(prefix))) {
        try { current = readJson(glossaryPath(prefix)); } catch (e) { return res.status(500).json({ error: e.message }); }
    }
    const text = projectSourceText(prefix);
    if (!text.trim()) return res.status(409).json({ error: 'This book has no text to match the glossary against yet' });
    res.json({ from, ...planImport(current, incoming, text) });
});

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
    // The source itself, needed twice below and so read once here rather than
    // hidden inside the branch that first wanted it.
    let source = '';
    if (fs.existsSync(statePath(prefix))) {
        const chunks = readJson(statePath(prefix)).chunks || [];
        bookTokens = chunks.reduce((n, c) => n + (c.tokens || Math.round((c.original || '').length / 4)), 0);
        // Counted the way the cheat sheet finds an entry (entryRegex): whole
        // words, a name with its case, any whitespace between the words of a
        // term. That last part matters because books arrive hard-wrapped —
        // "Modelview Matrix" is "Modelview\nMatrix" in Sterling's Junk DNA, and
        // a plain substring test called eight of that book's entries absent,
        // which is what the junk filter then offers to delete. The count used to
        // be a lower-cased substring, so it also credited "Face" with every
        // "face" — the very chunks the cheat sheet no longer sends it to.
        //
        // Run as it was, the regex over every chunk for every entry took three
        // seconds on Crystal Society (654 entries, 200 chunks) against one for
        // the substring test it replaced. Anything the regex finds contains the
        // entry's longest word in some case, so a lower-cased substring test on
        // that word rules most chunks out first and cannot rule a match out.
        const lowered = chunks.map(c => (c.original || '').toLowerCase());
        counts = terms.map(t => {
            const original = String(t.original || '').trim();
            if (!original) return 0;
            const probe = original.toLowerCase().split(/\s+/).reduce((a, w) => (w.length > a.length ? w : a), '');
            const re = entryRegex(t);
            return chunks.reduce((n, c, i) =>
                n + (lowered[i].includes(probe) && re.test(c.original || '') ? 1 : 0), 0);
        });
        source = chunks.map(c => c.original || '').join('\n');
        try {
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
        const { byRow, additions, hidden } = glossaryOutstanding(review, terms, source);
        if (findings.length === terms.length) byRow.forEach((list, i) => findings[i].push(...list));
        const outstanding = byRow.reduce((n, list) => n + list.length, 0) + additions.length;

        // Built field by field on purpose. The review file also holds the
        // findings that failed verification, and spreading the object would put
        // them one careless render away from looking like the rest.
        reviewMeta = {
            generatedAt: review.generatedAt,
            model: review.model,
            round: review.round ?? null,
            score: review.score ?? null,
            summary: review.summary || null,
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
        // and put the widest disagreement first. The warning before the translation
        // promised this list opens here, and for a while it did not.
        forms: formGroups(terms),
        // Forms of one name gathered around a prime, for the editor's people
        // view — see core/glossary_links.js. Indices into `terms`, like forms.
        people: personGroups(terms),
        noteLimit: MAX_NOTE_CHARS,
        review: reviewMeta,
        // The editor offers to run the review itself, and both of these decide
        // whether it may: a stage already running, or an estimate that will not
        // fit one call.
        running: jobManager.isRunning(prefix),
        estimate: { bookTokens, glossaryTokens, budget: config.pipeline.bookCallTokenBudget },
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

// One note for the forms of one name, written by the regular model from the
// notes the forms already have. Only the names and notes are sent, never the
// book: the notes are what is being condensed, and a call this size should cost
// nothing worth mentioning. The answer only fills the editor's field — the
// person reads it and decides.
app.post('/api/projects/:prefix/glossary/merge-note', async (req, res) => {
    const prefix = validPrefix(req, res);
    if (!prefix) return;
    const entries = (Array.isArray(req.body?.entries) ? req.body.entries : [])
        .slice(0, 30)
        .map(e => ({
            original: String(e?.original || '').slice(0, 120),
            translation: String(e?.translation || '').slice(0, 120),
            notes: String(e?.notes || '').slice(0, 1000),
        }))
        .filter(e => e.notes.trim());
    if (!entries.length) return res.status(400).json({ error: 'No notes to combine' });

    let cfg;
    try { cfg = await loadEffectiveConfig(); } catch (e) { return res.status(500).json({ error: e.message }); }
    const provider = cfg.activeProvider;
    const conf = cfg[PROVIDER_CONFIG_KEY[provider]];
    if (!conf) return res.status(400).json({ error: `Invalid provider: ${provider}` });

    let targetLang = cfg.translation?.targetLanguage;
    try { targetLang = readJson(statePath(prefix)).metadata?.targetLanguage || targetLang; } catch { /* no state yet */ }
    const prompts = getPrompts(cfg.translation?.promptLang);

    try {
        const client = createRawClient(provider, conf);
        const result = await Promise.race([
            client.invoke([
                { role: 'system', content: prompts.glossaryNote.system(targetLang, MAX_NOTE_CHARS) },
                { role: 'user', content: prompts.glossaryNote.user(entries) },
            ]),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 180000)),
        ]);
        const content = result?.content;
        const text = typeof content === 'string' ? content
            : Array.isArray(content) ? content.map(p => p?.text || '').join('') : '';
        const note = (extractFromTags(text, 'note') ?? text).replace(/\s+/g, ' ').trim();
        if (!note) return res.status(502).json({ error: 'The model returned an empty note' });
        res.json({ note, model: conf.modelName });
    } catch (e) {
        res.status(502).json({ error: e.message || String(e) });
    }
});
