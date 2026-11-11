/** The book passport: reading it and saving hand corrections. */
import fs from 'fs';
import { jobManager } from '../jobs.js';
import { acceptedNotes, povMapNeeded } from '../../src_v4/core/passport.js';
import { countTokens } from '../../src_v4/core/tokenizer.js';
import { app } from '../app.js';
import { statePath, passportPath, readJson, writeJsonAtomic, validPrefix, speechAdherence } from '../helpers.js';

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
        // Accepted notes ride along on every chunk, so their cost is per chunk.
        const notes = acceptedNotes(passport);
        const notesTokens = notes.length
            ? countTokens(notes.map(n => `- ${n.topic ? `${n.topic}: ` : ''}${n.advice}`).join('\n')) : 0;
        const translated = chunks.filter(c => c.translation).length;
        res.json({ exists: true, passport, totalChunks: total, translated, povMapNeeded: povMapNeeded(passport), notesTokens, speech: speechAdherence(chunks, passport?.dialogue?.marker || null) });
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
