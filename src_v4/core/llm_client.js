import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import config from '../config.js';

// Translating arbitrary book prose (violence, sex, profanity in fiction) trips
// Gemini's default safety filters, which then return zero candidates and make
// langchain crash reading `.message` of an empty generation. Disable blocking.
const GEMINI_SAFETY_SETTINGS = [
    HarmCategory.HARM_CATEGORY_HARASSMENT,
    HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
].map(category => ({ category, threshold: HarmBlockThreshold.BLOCK_NONE }));
import { RateLimiter } from '../utils/rate_limiter.js';
import { usageTracker } from './usage_tracker.js';

/**
 * Pull token counts out of an LLM response across the shapes the different
 * clients return. LangChain standardizes on `usage_metadata`; OpenAI-compatible
 * and Google clients sometimes only fill `response_metadata`. Returns null when
 * the backend reported no usage (e.g. some local servers without include_usage).
 */
export function extractUsage(response) {
    const um = response?.usage_metadata;
    if (um && (um.input_tokens != null || um.output_tokens != null)) {
        const i = um.input_tokens || 0, o = um.output_tokens || 0;
        return { inputTokens: i, outputTokens: o, totalTokens: um.total_tokens || i + o };
    }
    const rm = response?.response_metadata || {};
    const tu = rm.tokenUsage || rm.usage || rm.usageMetadata;
    if (tu) {
        const i = tu.promptTokens ?? tu.prompt_tokens ?? tu.input_tokens ?? tu.promptTokenCount ?? 0;
        const o = tu.completionTokens ?? tu.completion_tokens ?? tu.output_tokens ?? tu.candidatesTokenCount ?? 0;
        const t = tu.totalTokens ?? tu.total_tokens ?? tu.totalTokenCount ?? i + o;
        if (i || o || t) return { inputTokens: i, outputTokens: o, totalTokens: t };
    }
    return null;
}

/**
 * ChatGoogleGenerativeAI that reports WHY a response is empty.
 *
 * When the API blocks a request, langchain maps it to zero generations and the
 * block reason (promptFeedback) survives only inside `_generate`'s ChatResult —
 * `generate()` drops it in `_combineLLMOutput` and `invoke()` crashes with a
 * bare TypeError. So this is the last spot where the reason can be attached to
 * the error. Same for present-but-empty candidates: surface finishReason
 * (SAFETY / RECITATION / MAX_TOKENS / ...) instead of a silent empty string.
 */
class ChatGoogleGenerativeAIWithDiagnostics extends ChatGoogleGenerativeAI {
    async _generate(messages, options, runManager) {
        const result = await super._generate(messages, options, runManager);
        const gen = result.generations?.[0];
        if (!gen) {
            const feedback = result.llmOutput?.filters;
            const gemmaHint = /gemma/i.test(this.model)
                ? ' Gemma models have a built-in content filter that cannot be disabled via safety settings.'
                : '';
            const err = new Error(
                `[${this.model}] Google API returned an empty response (0 candidates)` +
                (feedback ? `; promptFeedback: ${JSON.stringify(feedback)}` : '') +
                `. Its content filter most likely blocked the text of this chunk.${gemmaHint}`
            );
            err.contentBlocked = true; // permanent for this text — retries won't help
            throw err;
        }
        const reason = gen.generationInfo?.finishReason;
        if (!gen.text && reason && reason !== 'STOP') {
            const ratings = gen.generationInfo?.safetyRatings;
            const err = new Error(
                `[${this.model}] Google API returned empty content; finishReason=${reason}` +
                (ratings?.length ? `, safetyRatings: ${JSON.stringify(ratings)}` : '') +
                (reason === 'MAX_TOKENS' ? '. Try raising maxOutputTokens in the settings.' : '')
            );
            // SAFETY / RECITATION / PROHIBITED_CONTENT / ... are permanent for
            // this text; MAX_TOKENS is a config problem, not a content block.
            err.contentBlocked = reason !== 'MAX_TOKENS';
            throw err;
        }
        return result;
    }
}

/**
 * Rewrite a failed invoke() error so the log shows the real cause.
 *
 * The worst offender: when the Gemini API returns zero candidates (its content
 * filter blocked the text, or the answer was cut off), langchain-core crashes
 * on `.generations[0][0].message` with a bare "Cannot read properties of
 * undefined (reading 'message')" and the actual reason never reaches the log.
 * We disable the filters via safetySettings, but Gemma models have a fixed
 * filter that ignores those settings, so books with rough scenes still hit this.
 */
export function explainInvokeError(error, provider, model) {
    if (provider === 'google' && error instanceof TypeError && error.message.includes("reading 'message'")) {
        const gemmaHint = /gemma/i.test(model)
            ? ' Gemma models have a built-in content filter that cannot be disabled — switch this project to a Gemini model to translate this chunk.'
            : '';
        const e = new Error(
            `[${model}] Google API returned an empty response (0 candidates). ` +
            `This usually means its content filter blocked the text of this chunk.${gemmaHint}`
        );
        e.cause = error;
        return e;
    }
    // Generic case: append provider details that `error.message` alone hides.
    const details = [
        error.status && `status=${error.status}`,
        error.code && `code=${error.code}`,
        error.errorDetails && `details=${JSON.stringify(error.errorDetails)}`,
    ].filter(Boolean).join(', ');
    if (details) error.message += ` (${details})`;
    return error;
}

// Provider id → the config block that holds its settings.
export const PROVIDER_CONFIG_KEY = {
    local: 'logic_model',
    google: 'google_model',
    groq: 'groq_model',
};

/**
 * Build a raw LangChain chat client for a provider from a plain config block.
 * No rate limiter, no shared state — used both by the runtime (LLMClient) and
 * the GUI "test" endpoint, so client construction lives in one place.
 * @param {'local'|'google'|'groq'} provider
 * @param {object} conf provider config block (modelName, apiKey, baseUrl, ...)
 */
export function createRawClient(provider, conf) {
    if (provider === 'google') {
        return new ChatGoogleGenerativeAIWithDiagnostics({
            apiKey: conf.apiKey,
            model: conf.modelName, // @langchain/google-genai expects `model`, not `modelName`
            temperature: conf.temperature,
            maxOutputTokens: conf.maxOutputTokens || 8192,
            safetySettings: GEMINI_SAFETY_SETTINGS,
        });
    }
    if (provider === 'groq') {
        // Groq exposes an OpenAI-compatible endpoint. We route it through
        // ChatOpenAI (same reliable client as local) instead of @langchain/groq,
        // whose groq-sdk path hangs/retries on "Premature close" with reasoning models.
        const timeoutMs = conf.timeout || 300000;
        return new ChatOpenAI({
            apiKey: conf.apiKey,
            modelName: conf.modelName,
            temperature: conf.temperature,
            streamUsage: true, // ask for token usage in the (streamed) response
            maxRetries: 0,
            timeout: timeoutMs,
            configuration: {
                baseURL: conf.baseUrl || 'https://api.groq.com/openai/v1',
                timeout: timeoutMs,
                maxRetries: 0,
            },
        });
    }
    // local / openAI-compatible endpoint
    const timeoutMs = conf.timeout || 4000000;
    return new ChatOpenAI({
        apiKey: conf.apiKey,
        configuration: {
            baseURL: conf.baseUrl,
            timeout: timeoutMs,
            maxRetries: 0,
        },
        timeout: timeoutMs,
        maxRetries: 0,
        streaming: true,
        streamUsage: true, // include token usage in the final streamed chunk
        modelName: conf.modelName,
        temperature: conf.temperature,
    });
}

class LLMClient {
    constructor() {
        this.clients = {
            logic: null
        };
        // Default provider comes from config (GUI settings); --model overrides it.
        this.provider = config.activeProvider || 'local'; // 'local' | 'google' | 'groq'
    }

    /** Human-readable model name of the active provider (for disclaimers, logs). */
    getModelName() {
        const conf = config[PROVIDER_CONFIG_KEY[this.provider]] || config.logic_model;
        return conf.modelName;
    }

    setProvider(provider) {
        if (provider !== 'local' && provider !== 'google' && provider !== 'groq') {
            throw new Error(`Invalid provider: ${provider}`);
        }
        this.provider = provider;
        // Reset clients to ensure correct one is created
        this.clients = { logic: null };
        console.log(`[LLM] Provider set to: ${this.provider}`);
    }

    /**
     * Get or initialize the requested client type.
     * @param {'logic'} type
     */
    getClient(type) {
        if (this.clients[type]) {
            return this.clients[type];
        }

        if (type !== 'logic') {
            throw new Error(`Unknown client type: ${type}`);
        }

        // Logic Model: Can be Local, Google, or Groq
        const conf = config[PROVIDER_CONFIG_KEY[this.provider]] || config.logic_model;
        const rpm = conf.maxRPM || 0;
        console.log(`[LLM] Initializing ${this.provider.toUpperCase()} logic client (${conf.modelName}) with RPM=${rpm}...`);
        const rawClient = createRawClient(this.provider, conf);

        // Wrap with Rate Limiter
        const limiter = new RateLimiter(rpm);

        // Capture identity for usage accounting (proxy closure can't read `this`).
        const provider = this.provider;
        const model = conf.modelName;

        // Proxy to intercept 'invoke' calls
        this.clients[type] = new Proxy(rawClient, {
            get(target, prop, receiver) {
                if (prop === 'invoke') {
                    return async function (...args) {
                        await limiter.waitForToken();
                        let response;
                        try {
                            response = await target.invoke(...args);
                        } catch (error) {
                            throw explainInvokeError(error, provider, model);
                        }
                        // Gemini (@langchain/google-genai) returns content as an
                        // array of parts; OpenAI-compatible providers return a
                        // plain string. Normalize to a string so all callers
                        // (extractFromTags, etc.) can rely on String methods.
                        if (response && Array.isArray(response.content)) {
                            response.content = response.content
                                .filter(part => part && part.type === 'text')
                                .map(part => part.text)
                                .join('');
                        }
                        try {
                            const usage = extractUsage(response);
                            if (usage) usageTracker.record({ provider, model, ...usage });
                        } catch { /* usage accounting must never break a translation */ }
                        return response;
                    };
                }
                return Reflect.get(target, prop, receiver);
            }
        });

        return this.clients[type];
    }
}

export const llmManager = new LLMClient();
