import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import config from '../config.js';
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
        return new ChatGoogleGenerativeAI({
            apiKey: conf.apiKey,
            model: conf.modelName, // @langchain/google-genai expects `model`, not `modelName`
            temperature: conf.temperature,
            maxOutputTokens: conf.maxOutputTokens || 8192,
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
                        const response = await target.invoke(...args);
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
