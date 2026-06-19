import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const defaults = {
    // Active LLM provider used when no --model override is passed on the CLI.
    // One of: 'local' | 'google' | 'groq'. Set via the GUI settings page.
    activeProvider: 'local',

    // --- Translation language settings ---
    // These are the defaults for CLI runs and for new projects created in the GUI.
    // Per-project values are stored in <prefix>_project_state.json metadata at
    // Stage 1; precedence at run time is: CLI flag > project metadata > these.
    translation: {
        // Language the pipeline translates INTO. Free-form string injected into
        // the prompts, so write it in the form that fits promptLang
        // (e.g. "немецкий" for promptLang 'ru', "German" for 'en').
        targetLanguage: 'русский',
        // Suffix for the exported file: <prefix>_<langSuffix>.txt
        langSuffix: 'rus',
        // Language of the model INSTRUCTIONS (the prompt templates), not the
        // target. One of: 'ru' | 'en'. Toggle in the GUI settings page.
        promptLang: 'ru',
    },

    logic_model: {
        baseUrl: 'http://127.0.0.1:8007/v1',
        apiKey: 'sk-no-key-required',
        modelName: 'qwen3.5-35b',
        timeout: 400000,
        temperature: 0.6,
        maxRPM: 10 // Local is usually fast
    },
    google_model: {
        apiKey: process.env.GOOGLE_API_KEY,
        modelName: 'gemini-3-flash-preview',
        timeout: 1200000,
        temperature: 0.9,
        maxRPM: 10, // Conservative for Google Free/Pay-as-you-go
        maxOutputTokens: 8192
    },
    // Custom OpenAI-compatible endpoint. Defaults to Groq, but baseUrl can point
    // at any OpenAI-compatible API (Together, OpenRouter, vLLM, ...).
    groq_model: {
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKey: process.env.GROQ_API_KEY,
        modelName: 'moonshotai/kimi-k2-instruct-0905',
        timeout: 300000,
        temperature: 0.7,
        maxRPM: 10 // Conservative for Groq
    },

    // --- Pipeline parameters ---
    pipeline: {
        // Tokenizer: chunk sizes (in tokens)
        chunkBaseTokens: 500,       // Minimum tokens before starting a new chunk
        chunkOverflowTokens: 500,   // Additional tokens before splitting

        // Stage 1: Extraction
        extractionMaxRetries: 3,

        // Stage 1b: Consolidation
        consolidationBatchSize: 30, // Terms per LLM batch
        consolidationMaxRetries: 3,

        // Stage 2: Translation loop
        translationMaxRetries: 10,
        approvalScoreThreshold: 9.1,    // Score >= this + like=1 → approved
        redraftScoreThreshold: 7.5,     // Score < this OR like=0 → retranslate from scratch
    }
};

// --- GUI overrides ---
// Optional config.overrides.json (next to this file) is deep-merged over the
// defaults above. The GUI settings page writes only that file, so config.js
// stays the source of defaults and keeps env-based secrets intact.
function deepMerge(base, over) {
    const out = Array.isArray(base) ? [...base] : { ...base };
    for (const k of Object.keys(over || {})) {
        const v = over[k];
        if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') {
            out[k] = deepMerge(out[k], v);
        } else {
            out[k] = v;
        }
    }
    return out;
}

let overrides = {};
try {
    const p = path.join(__dirname, 'config.overrides.json');
    if (fs.existsSync(p)) overrides = JSON.parse(fs.readFileSync(p, 'utf-8'));
} catch (e) {
    console.warn(`[config] Failed to read config.overrides.json: ${e.message}`);
}

export default deepMerge(defaults, overrides);
