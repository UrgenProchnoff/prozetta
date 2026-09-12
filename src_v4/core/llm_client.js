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
 * ChatOpenAI that reports WHY a response is empty — the same service the class
 * above does for Google, for the other half of the providers.
 *
 * The OpenAI shape carries the reason in `finish_reason`, and langchain keeps it
 * in `generationInfo` inside `_generate`. What the caller gets back does not
 * have it: off the non-streaming path `response_metadata` is given `usage` and
 * `system_fingerprint` only when the provider sent a fingerprint, and
 * `finish_reason` never at all. So this is the only place the reason can be
 * attached to the error.
 *
 * It matters most behind a gateway in front of Google, which is how a person
 * without a Google key reaches Gemini. A refusal arrives there as HTTP 200 with
 * `finish_reason: "content_filter: PROHIBITED_CONTENT"`, no `message` in the
 * choice at all, and zero completion tokens. Without this, a stage sees an empty
 * string, calls it "Empty response", and spends its whole retry budget — and the
 * next run's budget, since nothing gets marked — on text that will never come
 * back.
 */
class ChatOpenAIWithDiagnostics extends ChatOpenAI {
    async _generate(messages, options, runManager) {
        const result = await super._generate(messages, options, runManager);
        const gen = result.generations?.[0];
        if (gen?.text) return result;

        // Two shapes to read: the non-streaming path puts finish_reason in
        // generationInfo, the streaming one folds it into response_metadata.
        const reason = String(gen?.generationInfo?.finish_reason
            || gen?.message?.response_metadata?.finish_reason || '');
        const tu = result.llmOutput?.tokenUsage || result.llmOutput?.estimatedTokenUsage || {};
        const usage = extractUsage(gen?.message)
            || { inputTokens: tu.promptTokens, outputTokens: tu.completionTokens };
        const what = `[${this.model}] The provider returned ${gen ? 'empty content' : 'no answer at all'}`
            + (reason ? `; finish_reason=${reason}` : '; with no finish_reason to say why')
            + ` (${usage.inputTokens ?? '?'} tokens in, ${usage.outputTokens ?? 0} out)`;

        // A filter's refusal is permanent for this text: the same words are
        // refused every time, so the stage is told to stop rather than to spend
        // its budget proving it. The reason is matched loosely on purpose —
        // "content_filter" is the documented value, but a gateway in front of
        // another provider appends that provider's own word for it
        // ("content_filter: PROHIBITED_CONTENT").
        if (/content[_ -]?filter|safety|prohibited|blocked|recitation/i.test(reason)) {
            const err = new Error(`${what}. Its content filter blocked the text of this chunk.`);
            err.contentBlocked = true;
            throw err;
        }
        if (/length|max[_ ]?tokens/i.test(reason)) {
            throw new Error(`${what}. The answer ran into the output limit — raise maxOutputTokens in the settings.`);
        }
        // Anything else: an ordinary empty answer, or a provider that says
        // nothing about why. Worth saying out loud, not worth calling final —
        // another attempt may well come back with text.
        console.warn(`${what}.`);
        return result;
    }
}

// Parse a Google "45s" / "1.5s" / "0.75s" protobuf duration into milliseconds.
function parseDurationMs(s) {
    const m = /^([\d.]+)s$/.exec(String(s || '').trim());
    return m ? Math.round(parseFloat(m[1]) * 1000) : null;
}

/**
 * Recognize a rate-limit / quota error (HTTP 429) across providers and pull out
 * the useful bits: which quota was hit and how long the API asks us to wait.
 *
 * Google (google.rpc) puts them in a structured `errorDetails` array
 * (QuotaFailure.violations[].quotaId + RetryInfo.retryDelay); OpenAI-compatible
 * providers (Groq, local) use a Retry-After header or an "try again in 1.5s"
 * phrase in the message. Returns null when the error isn't a 429.
 */
export function parseRateLimit(error) {
    const status = error?.status ?? error?.response?.status ?? error?.code;
    const msg = String(error?.message || '');
    const is429 = status === 429 || status === 'RESOURCE_EXHAUSTED'
        || /\b429\b|too many requests|resource[_ ]?exhausted|rate.?limit|quota/i.test(msg);
    if (!is429) return null;

    let retryDelayMs = null, quotaId = null;

    // Google: structured google.rpc details (array of typed objects).
    const details = Array.isArray(error?.errorDetails) ? error.errorDetails : [];
    for (const d of details) {
        const type = d?.['@type'] || '';
        if (type.includes('QuotaFailure') && Array.isArray(d.violations) && d.violations[0]) {
            quotaId = d.violations[0].quotaId || d.violations[0].quotaMetric || quotaId;
        }
        if (type.includes('RetryInfo') && d.retryDelay) {
            retryDelayMs = parseDurationMs(d.retryDelay) ?? retryDelayMs;
        }
    }

    // OpenAI/Groq: Retry-After[-ms] header (object or Headers instance).
    const headers = error?.headers || error?.response?.headers;
    if (retryDelayMs == null && headers) {
        const get = (k) => (typeof headers.get === 'function' ? headers.get(k) : headers[k]);
        const raMs = get('retry-after-ms');
        const ra = get('retry-after');
        if (raMs != null && raMs !== '') retryDelayMs = parseInt(raMs, 10);
        else if (ra != null && ra !== '') retryDelayMs = Math.round(parseFloat(ra) * 1000);
    }
    // Last resort: an "in 1.5s" / "in 200ms" phrase inside the message.
    if (retryDelayMs == null) {
        const m = /(?:try again|retry) in\s+([\d.]+)\s*(ms|s)/i.exec(msg);
        if (m) retryDelayMs = Math.round(parseFloat(m[1]) * (m[2].toLowerCase() === 'ms' ? 1 : 1000));
    }

    if (retryDelayMs != null && !Number.isFinite(retryDelayMs)) retryDelayMs = null;
    return { retryDelayMs, quotaId, oversized: isOversizedPrompt(quotaId) };
}

/**
 * Is this a 429 that waiting cannot cure — one prompt larger than a per-minute
 * allowance?
 *
 * A per-minute quota normally clears by waiting, which is why 429s are retried
 * at all. But when the quota counts input tokens and a single request exceeds
 * the window on its own, every retry sends the same oversized prompt into the
 * same wall. Measured on Morphotrophic: a 195,000-token review was refused four
 * times over eight minutes, each attempt waiting out the delay the API itself
 * asked for, and it could not have succeeded on the hundredth.
 */
function isOversizedPrompt(quotaId) {
    return /InputTokens/i.test(String(quotaId || '')) && /PerMinute/i.test(String(quotaId || ''));
}

/**
 * Recognize a transient server-side failure — the provider is overloaded or
 * briefly down, and the very same request will succeed shortly.
 *
 * Observed in practice: a whole-book call died on "503 Service Unavailable:
 * This model is currently experiencing high demand", taking the stage down with
 * a stack trace. Unlike a content block (permanent for this text) or a daily
 * quota (won't clear soon), this is exactly the case worth waiting out — and it
 * is worth it most on book-level calls, where an abort burns a slot from a
 * 20-per-day allowance.
 *
 * Deliberately excludes 4xx other than 408/429: a bad key, a bad model name or
 * a malformed request will fail identically no matter how long we wait.
 */
export function isTransientServerError(error) {
    const status = Number(error?.status ?? error?.response?.status);
    const msg = String(error?.message || '');
    if ([500, 502, 503, 504, 408].includes(status)) return true;
    // Some clients surface the status only inside the message text.
    if (/\b(500|502|503|504)\b|service unavailable|internal (server )?error|bad gateway|gateway time-?out|overloaded|experiencing high demand/i.test(msg)) return true;
    // Network-level blips that never reached the provider.
    return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE'].includes(error?.code);
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
    // 429 / quota: annotate with structured fields so the invoke Proxy can wait
    // out the retryDelay, and give the log a plain-language reason.
    const rl = parseRateLimit(error);
    if (rl) {
        error.rateLimited = true;
        error.retryDelayMs = rl.retryDelayMs;
        error.quotaId = rl.quotaId;
        error.oversizedPrompt = rl.oversized;
        const quotaTxt = rl.quotaId ? ` (quota: ${rl.quotaId})` : '';
        if (rl.oversized) {
            error.message = `[${model}] The prompt is larger than this model's per-minute input allowance` +
                `${quotaTxt}. Waiting will not help — one request cannot fit in a window it exceeds on its own. ` +
                `Lower pipeline.bookCallTokenBudget so the size is caught before the call, or move to a paid tier.`;
            return error;
        }
        const waitTxt = rl.retryDelayMs ? `; API asks to retry after ${Math.round(rl.retryDelayMs / 1000)}s` : '';
        error.message = `[${model}] Rate limit hit — HTTP 429${quotaTxt}${waitTxt}. ` +
            `Lower maxRPM in settings or wait for the quota window to reset.`;
        return error;
    }

    // Transient provider outage: flag it so the invoke Proxy waits it out.
    if (isTransientServerError(error)) {
        error.transient = true;
        return error;
    }

    if (provider === 'google' && error instanceof TypeError && error.message.includes("reading 'message'")) {
        const gemmaHint = /gemma/i.test(model)
            ? ' Gemma models have a built-in content filter that cannot be disabled — switch this project to a Gemini model to translate this chunk.'
            : '';
        const e = new Error(
            `[${model}] Google API returned an empty response (0 candidates). ` +
            `This usually means its content filter blocked the text of this chunk.${gemmaHint}`
        );
        // The message said "blocked" but the flag was missing, so callers that
        // decide by the flag — every stage that skips a refused chunk instead of
        // aborting — treated this path as an unknown error and died. The
        // diagnostics subclass normally gets there first; this is the fallback
        // for when it does not, and it has to agree with it.
        e.contentBlocked = true;
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
 * A provider that exists only inside book_model: an OpenAI-compatible endpoint
 * with its own address and key. It is deliberately absent from
 * PROVIDER_CONFIG_KEY — it has no global block to be the active provider from,
 * and chunk-by-chunk work must not be able to select it by accident.
 */
export const BOOK_OWN_PROVIDER = 'openai';

/** Is the whole-book profile turned on at all? */
export function bookModelEnabled() {
    return config.book_model?.enabled !== false;
}

/**
 * A failed call in terms someone can act on.
 *
 * The raw messages are not usable as they are. A non-ASCII API key surfaces from
 * the Google SDK as "Cannot convert argument to a ByteString because the
 * character at index 0 has a value of 1053" — which names neither the key nor
 * the request — and an unreachable server as a bare "Connection error." with no
 * hint of the address it failed to reach.
 */
export function explainCallFailure(error, provider, conf) {
    const raw = String(error?.message || error);
    const where = `${provider}/${conf?.modelName || '?'}` + (conf?.baseUrl ? ` (${conf.baseUrl})` : '');

    if (/ByteString|API key not valid|api[_ -]?key|UNAUTHENTICATED|PERMISSION_DENIED|\b40[13]\b/i.test(raw)) {
        return `${where}: the API key is missing or wrong. Check it in Settings. [${raw}]`;
    }
    if (/Connection error|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|timeout/i.test(raw)) {
        return `${where}: nothing answered. Is the server running and the address right? [${raw}]`;
    }
    if (/unexpected model name|model.*not found|\b404\b/i.test(raw)) {
        return `${where}: the provider does not recognise this model name. [${raw}]`;
    }
    return `${where}: ${raw}`;
}

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
    if (provider === 'groq' || provider === BOOK_OWN_PROVIDER) {
        // Groq exposes an OpenAI-compatible endpoint. We route it through
        // ChatOpenAI (same reliable client as local) instead of @langchain/groq,
        // whose groq-sdk path hangs/retries on "Premature close" with reasoning models.
        // The book profile's own endpoint is the same shape, minus the default
        // address: pointing it somewhere is the entire reason it exists.
        const timeoutMs = conf.timeout || 300000;
        if (provider === BOOK_OWN_PROVIDER && !conf.baseUrl) {
            throw new Error('book_model uses the "openai" provider but no baseUrl is set — ' +
                'give it the address of an OpenAI-compatible endpoint, or pick another provider.');
        }
        return new ChatOpenAIWithDiagnostics({
            // A self-hosted endpoint usually wants no key, but the client
            // refuses to start without one and blames "Missing credentials",
            // which reads as an authentication problem rather than a placeholder
            // problem. The local slot carries the same stand-in by default.
            apiKey: conf.apiKey || 'sk-no-key-required',
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
    return new ChatOpenAIWithDiagnostics({
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
            logic: null,
            book: null
        };
        // Default provider comes from config (GUI settings); --model overrides it.
        this.provider = config.activeProvider || 'local'; // 'local' | 'google' | 'groq'
    }

    /** Human-readable model name of the active provider (for disclaimers, logs). */
    getModelName() {
        const conf = config[PROVIDER_CONFIG_KEY[this.provider]] || config.logic_model;
        return conf.modelName;
    }

    /**
     * Settings for whole-book calls: the book_model block laid over the config
     * of the provider it names, so connection details (apiKey, baseUrl) are
     * inherited and only what differs has to be filled in.
     */
    getBookSettings() {
        const book = config.book_model || {};
        const provider = book.provider || this.provider;
        if (!PROVIDER_CONFIG_KEY[provider] && provider !== BOOK_OWN_PROVIDER) {
            throw new Error(`Invalid provider in book_model: "${provider}". ` +
                `Expected one of: ${[...Object.keys(PROVIDER_CONFIG_KEY), BOOK_OWN_PROVIDER].join(', ')}.`);
        }
        // The book profile's own endpoint inherits nothing: its whole point is to
        // be a different machine from the one doing the chunk-by-chunk work.
        const base = provider === BOOK_OWN_PROVIDER ? {} : (config[PROVIDER_CONFIG_KEY[provider]] || {});
        const conf = { ...base };
        for (const [key, value] of Object.entries(book)) {
            if (key === 'provider') continue;
            if (value !== undefined && value !== null && value !== '') conf[key] = value;
        }
        return { provider, conf };
    }

    setProvider(provider) {
        if (provider !== 'local' && provider !== 'google' && provider !== 'groq') {
            throw new Error(`Invalid provider: ${provider}`);
        }
        this.provider = provider;
        // Reset the chunk-level client so the new provider takes effect. The
        // book client is untouched: it carries its own provider and must not
        // follow --model or the GUI's active-provider switch.
        this.clients.logic = null;
        console.log(`[LLM] Provider set to: ${this.provider}`);
    }

    /**
     * Get or initialize the requested client type.
     * @param {'logic'|'book'} type  'logic' — per-chunk work on the active
     *   provider; 'book' — whole-book calls on the book_model profile.
     */
    getClient(type) {
        if (this.clients[type]) {
            return this.clients[type];
        }

        if (type !== 'logic' && type !== 'book') {
            throw new Error(`Unknown client type: ${type}`);
        }

        const { provider, conf } = type === 'book'
            ? this.getBookSettings()
            : { provider: this.provider, conf: config[PROVIDER_CONFIG_KEY[this.provider]] || config.logic_model };

        const rpm = conf.maxRPM || 0;
        console.log(`[LLM] Initializing ${provider.toUpperCase()} ${type} client (${conf.modelName}) with RPM=${rpm}...`);
        const rawClient = createRawClient(provider, conf);

        // Wrap with Rate Limiter
        const limiter = new RateLimiter(rpm);

        // Capture identity for usage accounting (proxy closure can't read `this`).
        // Note this is the client's own provider, not necessarily the active one:
        // a book client may run on Google while chunks go to a local server.
        const model = conf.modelName;

        // Proxy to intercept 'invoke' calls
        this.clients[type] = new Proxy(rawClient, {
            get(target, prop, receiver) {
                if (prop === 'invoke') {
                    return async function (...args) {
                        // Wait out short-lived 429s (a per-minute quota clears by
                        // waiting the retryDelay the API returns). A multi-minute
                        // delay (per-day quota) won't clear soon, so we surface it
                        // to the caller instead of blocking the whole run.
                        const MAX_RATE_RETRIES = 3;
                        const MAX_WAIT_MS = 65000;
                        // A provider outage lasts seconds to a couple of minutes,
                        // so it gets its own budget with exponential backoff:
                        // 5s, 10s, 20s, 40s. Losing a stage to a blip is worse
                        // than waiting — especially on book-level calls, where an
                        // abort costs one of 20 daily slots.
                        const MAX_TRANSIENT_RETRIES = 4;
                        let transientAttempts = 0;
                        let response;
                        for (let attempt = 0; ; attempt++) {
                            await limiter.waitForToken();
                            try {
                                response = await target.invoke(...args);
                                break;
                            } catch (rawError) {
                                const error = explainInvokeError(rawError, provider, model);
                                // A prompt bigger than the per-minute input
                                // window fails identically however long we wait,
                                // and the waiting is not free: four attempts on
                                // Morphotrophic cost eight minutes to learn
                                // nothing the first attempt had not already said.
                                if (error.oversizedPrompt) throw error;
                                if (error.rateLimited && attempt < MAX_RATE_RETRIES) {
                                    const waitMs = error.retryDelayMs ?? (attempt + 1) * 10000;
                                    if (waitMs <= MAX_WAIT_MS) {
                                        console.warn(`[LLM] ${error.message} Waiting ${Math.round(waitMs / 1000)}s, retry ${attempt + 1}/${MAX_RATE_RETRIES}...`);
                                        await new Promise(r => setTimeout(r, waitMs));
                                        continue;
                                    }
                                }
                                if (error.transient && transientAttempts < MAX_TRANSIENT_RETRIES) {
                                    const waitMs = 5000 * Math.pow(2, transientAttempts);
                                    transientAttempts++;
                                    console.warn(`[LLM] [${model}] Provider is temporarily unavailable (${String(error.message).slice(0, 120)}). ` +
                                        `Waiting ${Math.round(waitMs / 1000)}s, retry ${transientAttempts}/${MAX_TRANSIENT_RETRIES}...`);
                                    await new Promise(r => setTimeout(r, waitMs));
                                    continue;
                                }
                                throw error;
                            }
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
