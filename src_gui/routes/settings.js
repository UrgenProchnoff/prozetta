/** Settings: the effective configuration, presets, connection tests and the Google model list. */
import fs from 'fs';
import { createRawClient, PROVIDER_CONFIG_KEY } from '../../src_v4/core/llm_client.js';
import { writeFileAtomic } from '../../src_v4/utils/atomic_write.js';
import { reloadConfig } from '../../src_v4/config.js';
import { OVERRIDES_PATH, PRESETS_PATH, app } from '../app.js';
import { bookEffective, loadEffectiveConfig } from '../helpers.js';

// --- API: settings (config.js defaults + config.overrides.json) ---

const MODEL_GROUPS = ['logic_model', 'google_model', 'groq_model', 'book_model'];
const PROVIDERS = ['local', 'google', 'groq'];

function readOverrides() {
    if (!fs.existsSync(OVERRIDES_PATH)) return {};
    try { return JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf-8')); }
    catch { return {}; }
}

function writeOverrides(overrides) {
    writeFileAtomic(OVERRIDES_PATH, JSON.stringify(overrides, null, 2));
    reloadConfig();
}

// --- Settings presets: a named copy of one card's settings ---
//
// Free tiers run out, and the answer is another service with another address,
// another key and another model name. That is four fields to retype from memory,
// or from a text file somebody keeps beside the program — which is what the
// person who asked for this was doing.
//
// A preset is a snapshot of one group as it is saved, keys and all. It lives
// beside config.overrides.json and is gitignored for the same reason: what is in
// it is a set of credentials.
function readPresets() {
    if (!fs.existsSync(PRESETS_PATH)) return {};
    try { return JSON.parse(fs.readFileSync(PRESETS_PATH, 'utf-8')); }
    catch { return {}; }
}

function writePresets(presets) {
    writeFileAtomic(PRESETS_PATH, JSON.stringify(presets, null, 2));
}

const PRESET_LIMIT = 30;

/** The group and name from a request, or null — which has already answered. */
function presetTarget(req, res) {
    const group = String(req.body?.group ?? req.query?.group ?? '');
    const name = String(req.body?.name ?? req.query?.name ?? '').trim();
    if (!MODEL_GROUPS.includes(group)) {
        res.status(400).json({ error: `Unknown settings group: ${group}` });
        return null;
    }
    if (!name || name.length > 40 || /[\u0000-\u001f]/.test(name)) {
        res.status(400).json({ error: 'A preset needs a name of 1-40 characters' });
        return null;
    }
    return { group, name };
}

/** Names only: the values hold an API key and have no business in a page. */
app.get('/api/config/presets', (req, res) => {
    const group = String(req.query.group || '');
    if (!MODEL_GROUPS.includes(group)) return res.status(400).json({ error: `Unknown settings group: ${group}` });
    res.json({ names: Object.keys(readPresets()[group] || {}).sort((a, b) => a.localeCompare(b)) });
});

// Snapshot what is saved, not what is typed: the form never holds the API key —
// its field says "new key (empty — keep)" and starts empty — so a preset built
// from the form would be a preset that cannot connect. The page saves first and
// then asks for this, which makes the two the same thing.
//
// Every field of the card, as it is in effect — the default where nothing was
// saved over it. The snapshot used to be the saved overrides alone, which hold
// only the fields someone once changed: a preset made while the timeout was
// still the default carried no timeout, and applying it — which replaces the
// card — set the timeout back to the default whatever the service had needed.
// A preset is meant to bring a whole service back, so it holds all of it.
app.post('/api/config/presets', async (req, res) => {
    const target = presetTarget(req, res);
    if (!target) return;
    let cfg;
    try { cfg = await loadEffectiveConfig(); } catch (e) { return res.status(500).json({ error: e.message }); }
    const saved = { ...(cfg[target.group] || {}) };
    // The key is the exception: only one typed into the settings. The default
    // it would otherwise fall back to is the environment variable, and copying
    // that into the preset did two things nobody asked for. It wrote to disk a
    // key someone had kept out of files on purpose. And applying the preset put
    // that copy into the saved settings, which outrank the environment — the
    // key froze, and changing the variable afterwards did nothing. A preset
    // without a key keeps whatever key is in force when it is applied.
    const typedKey = readOverrides()[target.group]?.apiKey;
    if (typedKey) saved.apiKey = typedKey;
    else delete saved.apiKey;
    const presets = readPresets();
    presets[target.group] = presets[target.group] || {};
    if (!(target.name in presets[target.group]) && Object.keys(presets[target.group]).length >= PRESET_LIMIT) {
        return res.status(400).json({ error: `That is ${PRESET_LIMIT} presets on one card — delete one first` });
    }
    presets[target.group][target.name] = { ...saved };
    writePresets(presets);
    res.json({ ok: true, names: Object.keys(presets[target.group]).sort((a, b) => a.localeCompare(b)) });
});

// The group is replaced rather than merged: a preset is a whole card, and
// merging would leave the previous service's address behind whenever the new one
// does not name it. The key is the exception — a preset that carries none means
// "not mine to say", so the saved one stays rather than being wiped.
app.post('/api/config/presets/apply', async (req, res) => {
    const target = presetTarget(req, res);
    if (!target) return;
    const preset = readPresets()[target.group]?.[target.name];
    if (!preset) return res.status(404).json({ error: `No preset named "${target.name}"` });

    const overrides = readOverrides();
    const currentKey = overrides[target.group]?.apiKey;
    overrides[target.group] = { ...preset };
    if (!overrides[target.group].apiKey && currentKey) overrides[target.group].apiKey = currentKey;

    try { writeOverrides(overrides); }
    catch (e) { return res.status(500).json({ error: e.message }); }

    try {
        const fresh = await loadEffectiveConfig();
        res.json({ ok: true, groups: describeConfig(fresh, overrides), activeProvider: fresh.activeProvider || 'local' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/config/presets', (req, res) => {
    const target = presetTarget(req, res);
    if (!target) return;
    const presets = readPresets();
    if (!presets[target.group]?.[target.name]) return res.status(404).json({ error: `No preset named "${target.name}"` });
    delete presets[target.group][target.name];
    if (!Object.keys(presets[target.group]).length) delete presets[target.group];
    writePresets(presets);
    res.json({ ok: true, names: Object.keys(presets[target.group] || {}).sort((a, b) => a.localeCompare(b)) });
});

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

    const a = cfg.app || {};
    const aFields = Object.keys(a).map(key => ({
        key, type: fieldType(key, a[key]), value: a[key],
        overridden: !!(ovr.app && Object.prototype.hasOwnProperty.call(ovr.app, key))
    }));
    groups.push({ id: 'app', kind: 'app', fields: aFields });

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
    const validGroups = [...MODEL_GROUPS, 'pipeline', 'translation', 'app'];

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

    try { writeOverrides(overrides); }
    catch (e) { return res.status(500).json({ error: e.message }); }

    const fresh = await loadEffectiveConfig();
    res.json({ ok: true, groups: describeConfig(fresh, overrides), activeProvider: fresh.activeProvider || 'local' });
});

app.post('/api/config/reset', async (req, res) => {
    try {
        if (fs.existsSync(OVERRIDES_PATH)) fs.unlinkSync(OVERRIDES_PATH);
        reloadConfig();
        const cfg = await loadEffectiveConfig();
        res.json({ ok: true, groups: describeConfig(cfg, {}), activeProvider: cfg.activeProvider || 'local' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * Form values typed after a settings group: numbers as numbers, booleans as
 * booleans, the rest as strings. A value that does not parse is left out, so the
 * saved or default one stands, as it does when the form is saved. The API key is
 * passed through untouched: empty means "keep the saved one".
 */
function typedValues(group, values) {
    const out = {};
    for (const [key, raw] of Object.entries(values)) {
        if (key === 'apiKey' || !Object.prototype.hasOwnProperty.call(group, key)) { out[key] = raw; continue; }
        const typed = coerce(fieldType(key, group[key]), raw);
        if (typed !== null) out[key] = typed;
    }
    return out;
}

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
    //
    // The form sends every field as a string, so for this card they are typed
    // first, against the card's own defaults. They used to be laid over the
    // provider's settings raw, after which each field's type was read off the
    // string itself: the timeout reached the OpenAI client as "1800000", which
    // it refuses before sending anything — "timeout must be an integer" — so the
    // test failed for every provider but Google.
    const { effective, provider: bookProvider } = isBook
        ? bookEffective(cfg, typedValues(cfg.book_model || {}, values || {}))
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
