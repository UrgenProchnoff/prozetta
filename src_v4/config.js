export default {
    logic_model: {
        baseUrl: 'http://127.0.0.1:8007/v1',
        apiKey: 'sk-no-key-required',
        modelName: 'qwen3-80b-instruct',
        timeout: 1200000,
        temperature: 0.5,
        maxRPM: 1000 // Local is usually fast
    },
    fast_model: {
        baseUrl: 'http://127.0.0.1:8008/v1',
        apiKey: 'sk-no-key-required',
        modelName: 'hy-mt-1.5-7b',
        timeout: 300000,
        temperature: 0.3,
        maxRPM: 1000
    },
    google_model: {
        apiKey: process.env.GOOGLE_API_KEY,
        modelName: 'gemini-3-flash-preview',
        timeout: 1200000,
        temperature: 0.9,
        maxRPM: 10 // Conservative for Google Free/Pay-as-you-go
    },
    groq_model: {
        apiKey: process.env.GROQ_API_KEY,
        modelName: 'moonshotai/kimi-k2-instruct-0905',
        timeout: 300000,
        temperature: 0.7,
        maxRPM: 10 // Conservative for Groq
    }
};
