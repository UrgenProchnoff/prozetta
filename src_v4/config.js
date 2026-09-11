import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const defaults = {
    // Active LLM provider used when no --model override is passed on the CLI.
    // One of: 'local' | 'google' | 'groq' (the other-service card). Set on the
    // settings page.
    activeProvider: 'local',

    // --- Translation language settings ---
    // These are the defaults for CLI runs and for new projects created in the GUI.
    // Per-project values are stored in <prefix>_project_state.json metadata at
    // extraction; precedence at run time is: CLI flag > project metadata > these.
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
    // Any OpenAI-compatible endpoint: OpenRouter, Together, NVIDIA NIM, a vLLM
    // of your own. The default address is one such service rather than a
    // recommendation — the field is there to be replaced.
    // The group keeps its old name because it is the name in everyone's saved
    // settings; what a person types is --model=custom and CUSTOM_API_KEY.
    groq_model: {
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKey: process.env.CUSTOM_API_KEY || process.env.GROQ_API_KEY,
        modelName: 'moonshotai/kimi-k2-instruct-0905',
        timeout: 300000,
        temperature: 0.7,
        maxRPM: 10 // Conservative for a free tier
    },

    // --- Whole-book calls ---
    // A separate profile for the passes that read the entire book in one go:
    // the cast of point-of-view characters and their dossiers, glossary
    // revision, cross-chunk review. Chunk-by-chunk work wants a fast, cheap
    // model; these want a large context window, so this profile carries its own
    // provider instead of following activeProvider.
    book_model: {
        // Whether whole-book passes are available at all. Off means the passport
        // and glossary-review stages refuse to run and the interface stops
        // offering them — a pipeline that only ever translates chunk by chunk
        // needs no large model, and should not be nagged about one it has not
        // configured.
        enabled: true,
        // 'local' | 'google' | 'groq' | 'openai'. The first three inherit their
        // connection from that provider's own block above, so a key entered once
        // does not have to be entered twice. 'openai' is this profile's own
        // OpenAI-compatible endpoint: it inherits nothing and uses the baseUrl
        // and apiKey below, so a rented large-context server can be pointed at
        // without disturbing the model that does the chunk-by-chunk work.
        provider: 'google',
        // Only for provider 'openai'; empty on the others means "inherit".
        baseUrl: '',
        apiKey: '',
        // Pinned on purpose rather than an alias like gemini-flash-latest: a
        // moving target would change what these passes produce without warning.
        modelName: 'gemini-3.7-flash',
        timeout: 1800000,
        // Low: these calls extract facts and produce structured answers, they
        // are not supposed to invent prose.
        temperature: 0.3,
        // Free-tier Gemini allows 250k tokens per minute, and a single
        // book-sized prompt already eats most of that — a second call inside the
        // same minute gets refused regardless of the requests-per-minute quota.
        maxRPM: 1,
        // The models themselves allow 65536 out. Book-level answers are meant to
        // be compact (a glossary diff, not a rewritten glossary), but a truncated
        // answer costs a whole call, so leave headroom above what we expect.
        maxOutputTokens: 16384,
    },

    // --- Pipeline parameters ---
    pipeline: {
        // Tokenizer: chunk sizes (in tokens)
        chunkBaseTokens: 500,       // Minimum tokens before starting a new chunk
        chunkOverflowTokens: 500,   // Additional tokens before splitting

        // Extraction
        extractionMaxRetries: 3,

        // Consolidation
        consolidationBatchSize: 30, // Terms per LLM batch
        consolidationMaxRetries: 3,

        // How much of a character's dossier reaches the translation prompt.
        // Measured on real passports, a dossier runs 127–228 tokens, so this is
        // headroom rather than a working limit — it exists only to stop one
        // enormous entry from crowding out the text being translated.
        dossierMaxTokens: 600,

        // Whole-book calls (passport, glossary review, translation review): how
        // many tokens one prompt may carry. The binding constraint is the
        // provider's tokens per minute, not the model's context window, and the
        // call is refused outright rather than truncated.
        //
        // 250,000 was the documented figure and it is the wrong one: that is the
        // total per-minute allowance, while what actually refuses these calls is
        // a separate, lower quota over INPUT alone —
        // GenerateContentInputTokensPerModelPerMinute-FreeTier. Measured on
        // gemini-3.7-flash free tier: 157,411 / 159,533 / 167,843 / 167,852
        // tokens of input all went through, and ~195,000 was refused four times
        // over eight minutes. So the ceiling sits between 168k and 195k, and this
        // sits just above the largest input actually seen accepted — blocking a
        // call the provider has already taken is as wrong as passing one it will
        // refuse.
        //
        // No safety margin on top, because none is needed any more: the callers
        // now count the instructions as well as the data, and the glossary review
        // of Morphotrophic estimates 167,850 against the 167,852 the API charged.
        // Raise this on a paid tier.
        bookCallTokenBudget: 170000,

        // Translation loop
        translationMaxRetries: 10,
        approvalScoreThreshold: 9.1,    // Score >= this + like=1 → approved
        redraftScoreThreshold: 7.5,     // Score < this OR like=0 → retranslate from scratch
        // A redraft repeats the very same draft call, so when the reviewer keeps
        // rejecting redrafts it is almost always a rules conflict, not a bad
        // translation (measured: one chunk burned 9 redrafts on a complaint the
        // human proofread later proved wrong). Cap redrafts separately from the
        // overall retry budget.
        translationMaxRedrafts: 3,
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
