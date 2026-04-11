export default {
    logic_model: {
        baseUrl: 'http://127.0.0.1:8007/v1',
        apiKey: 'sk-no-key-required',
        modelName: 'qwen3.5-35b',
        timeout: 400000,
        temperature: 0.6,
        maxRPM: 10 // Local is usually fast
    },
    fast_model: {
        baseUrl: 'http://127.0.0.1:8008/v1',
        apiKey: 'sk-no-key-required',
        modelName: 'hy-mt-1.5-7b',
        timeout: 300000,
        temperature: 0.3,
        maxRPM: 10
    },
    google_model: {
        apiKey: process.env.GOOGLE_API_KEY,
        modelName: 'gemini-3-flash-preview',
        timeout: 1200000,
        temperature: 0.9,
        maxRPM: 10, // Conservative for Google Free/Pay-as-you-go
        maxOutputTokens: 8192
    },
    groq_model: {
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
