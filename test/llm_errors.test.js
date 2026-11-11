/**
 * How a failed model call is classified. Each kind is retried differently —
 * or not at all — so a wrong class is minutes wasted on a request that cannot
 * succeed, or a run ended by a blip.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    extractUsage, parseRateLimit, isTransientServerError, failureSummary,
    explainInvokeError, explainCallFailure,
} from '../src_v4/core/llm_client.js';

const error = (message, extra = {}) => Object.assign(new Error(message), extra);

// --- extractUsage ---

test('extractUsage reads the standard usage_metadata', () => {
    assert.deepEqual(extractUsage({ usage_metadata: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } }),
        { inputTokens: 100, outputTokens: 20, totalTokens: 120 });
});

test('extractUsage counts thinking as output when only the total includes it', () => {
    assert.deepEqual(extractUsage({ usage_metadata: { input_tokens: 100, output_tokens: 20, total_tokens: 500 } }),
        { inputTokens: 100, outputTokens: 400, totalTokens: 500 });
});

test('extractUsage falls back to the provider shapes in response_metadata', () => {
    assert.deepEqual(extractUsage({ response_metadata: { tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } } }),
        { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    assert.deepEqual(extractUsage({ response_metadata: { usage: { prompt_tokens: 10, completion_tokens: 5 } } }),
        { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    assert.deepEqual(extractUsage({ response_metadata: { usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 } } }),
        { inputTokens: 7, outputTokens: 3, totalTokens: 10 });
});

test('extractUsage is null when the backend reported nothing', () => {
    assert.equal(extractUsage({}), null);
    assert.equal(extractUsage(undefined), null);
    assert.equal(extractUsage({ response_metadata: { usage: {} } }), null);
});

// --- parseRateLimit ---

test('parseRateLimit is null for anything that is not a 429', () => {
    assert.equal(parseRateLimit(error('Bad request', { status: 400 })), null);
    assert.equal(parseRateLimit(error('Internal error', { status: 500 })), null);
});

test('parseRateLimit reads Google quota details and the delay the API asks for', () => {
    const rl = parseRateLimit(error('quota', {
        status: 429,
        errorDetails: [
            { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] },
            { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '33.5s' },
        ],
    }));
    assert.deepEqual(rl, { retryDelayMs: 33500, quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', oversized: false });
});

test('parseRateLimit marks a per-minute input-token quota as possibly oversized', () => {
    const rl = parseRateLimit(error('quota', {
        status: 429,
        errorDetails: [{ '@type': 'x.QuotaFailure', violations: [{ quotaId: 'GenerateContentInputTokensPerModelPerMinute-FreeTier' }] }],
    }));
    assert.equal(rl.oversized, true);
});

test('parseRateLimit reads Retry-After headers, plain or as a Headers object', () => {
    assert.equal(parseRateLimit(error('Too many requests', { status: 429, headers: { 'retry-after': '2' } })).retryDelayMs, 2000);
    assert.equal(parseRateLimit(error('Too many requests', { status: 429, headers: { 'retry-after-ms': '1500', 'retry-after': '9' } })).retryDelayMs, 1500);
    assert.equal(parseRateLimit(error('Too many requests', { status: 429, headers: new Headers({ 'retry-after': '3' }) })).retryDelayMs, 3000);
});

test('parseRateLimit recognises a 429 from the message alone and reads its delay', () => {
    assert.equal(parseRateLimit(error('Rate limit reached. Please try again in 1.5s.')).retryDelayMs, 1500);
    assert.equal(parseRateLimit(error('Rate limit reached. Please retry in 200ms.')).retryDelayMs, 200);
    assert.deepEqual(parseRateLimit(error('429 Too Many Requests')), { retryDelayMs: null, quotaId: null, oversized: false });
});

// --- isTransientServerError ---

test('isTransientServerError accepts server statuses and timeouts, not client errors', () => {
    for (const status of [500, 502, 503, 504, 408]) assert.equal(isTransientServerError({ status, message: '' }), true, String(status));
    for (const status of [400, 401, 403, 404]) assert.equal(isTransientServerError({ status, message: 'nope' }), false, String(status));
});

test('isTransientServerError reads a status written into the message', () => {
    assert.equal(isTransientServerError(error('[503 Service Unavailable] This model is currently experiencing high demand')), true);
    assert.equal(isTransientServerError(error('Request failed: HTTP 502')), true);
    assert.equal(isTransientServerError(error('500 status code (no body)')), true);
    assert.equal(isTransientServerError(error('The model is overloaded')), true);
});

test('isTransientServerError does not take a bare number for an outage', () => {
    // These once read as outages and were retried for over a minute.
    assert.equal(isTransientServerError(error('max_tokens must be at most 500')), false);
    assert.equal(isTransientServerError(error('input of 503 tokens exceeds the limit')), false);
});

test('isTransientServerError accepts network failures, by code or by cause', () => {
    assert.equal(isTransientServerError(error('read ECONNRESET', { code: 'ECONNRESET' })), true);
    assert.equal(isTransientServerError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } })), true);
    assert.equal(isTransientServerError(new TypeError('fetch failed')), true);
    assert.equal(isTransientServerError(error('Connection error.', { name: 'APIConnectionError' })), true);
});

// --- failureSummary ---

test('failureSummary drops the request address and keeps the reason', () => {
    const e = error('[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent: [503 Service Unavailable] This model is currently experiencing high demand');
    assert.equal(failureSummary(e), '[503 Service Unavailable] This model is currently experiencing high demand');
});

test('failureSummary adds the status and the network code when the message lacks them', () => {
    assert.equal(failureSummary(error('Bad gateway', { status: 502 })), 'HTTP 502 Bad gateway');
    assert.equal(failureSummary(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })), 'fetch failed (ECONNRESET)');
    assert.equal(failureSummary(undefined), 'no reason given');
});

// --- explainInvokeError ---

test('explainInvokeError flags a rate limit and words it for the log', () => {
    const e = explainInvokeError(error('quota', { status: 429, headers: { 'retry-after': '30' } }), 'groq', 'model-x');
    assert.equal(e.rateLimited, true);
    assert.equal(e.retryDelayMs, 30000);
    assert.equal(e.oversizedPrompt, false);
    assert.match(e.message, /^\[model-x\] Rate limit hit — HTTP 429; API asks to retry after 30s/);
});

test('explainInvokeError says that waiting will not cure an oversized prompt', () => {
    const e = explainInvokeError(error('quota', {
        status: 429,
        errorDetails: [{ '@type': 'x.QuotaFailure', violations: [{ quotaId: 'InputTokensPerMinute' }] }],
    }), 'google', 'model-x');
    assert.equal(e.oversizedPrompt, true);
    assert.match(e.message, /Waiting will not help/);
});

test('explainInvokeError flags a transient outage and leaves its message alone', () => {
    const e = explainInvokeError(error('Service Unavailable', { status: 503 }), 'google', 'model-x');
    assert.equal(e.transient, true);
    assert.equal(e.message, 'Service Unavailable');
});

test('explainInvokeError turns the empty-candidates crash into a content block', () => {
    const crash = new TypeError("Cannot read properties of undefined (reading 'message')");
    const e = explainInvokeError(crash, 'google', 'gemma-3');
    assert.equal(e.contentBlocked, true);
    assert.equal(e.cause, crash);
    assert.match(e.message, /0 candidates/);
    assert.match(e.message, /Gemma models have a built-in content filter/);

    // The same crash from another provider is not known to mean that.
    assert.equal(explainInvokeError(new TypeError("Cannot read properties of undefined (reading 'message')"), 'local', 'm').contentBlocked, undefined);
});

test('explainInvokeError appends the details a bare message hides', () => {
    const e = explainInvokeError(error('Invalid argument', { status: 400, code: 'INVALID_ARGUMENT' }), 'google', 'model-x');
    assert.equal(e.message, 'Invalid argument (status=400, code=INVALID_ARGUMENT)');
    assert.equal(e.rateLimited, undefined);
    assert.equal(e.transient, undefined);
});

// --- explainCallFailure ---

test('explainCallFailure names the thing a person can fix', () => {
    const conf = { modelName: 'm', baseUrl: 'http://127.0.0.1:8007/v1' };
    assert.match(explainCallFailure(error('Cannot convert argument to a ByteString because the character at index 0 has a value of 1053'), 'google', { modelName: 'g' }),
        /^google\/g: the API key is missing or wrong/);
    assert.match(explainCallFailure(error('Connection error.'), 'local', conf),
        /^local\/m \(http:\/\/127\.0\.0\.1:8007\/v1\): nothing answered/);
    assert.match(explainCallFailure(error('404 model not found'), 'groq', conf), /does not recognise this model name/);
    assert.equal(explainCallFailure(error('something else'), 'groq', { modelName: 'm' }), 'groq/m: something else');
});
