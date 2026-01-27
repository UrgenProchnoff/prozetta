export default {
    logic_model: {
        baseUrl: 'http://127.0.0.1:8007/v1',
        apiKey: 'sk-no-key-required', // Usually local servers don't need keys
        modelName: 'qwen3-80b-instruct', // Placeholder, important for headers but often ignored by local server
        timeout: 1200000, // 20 minutes (for large thinking models)
        temperature: 0.5,
    },
    fast_model: {
        baseUrl: 'http://127.0.0.1:8008/v1',
        apiKey: 'sk-no-key-required',
        modelName: 'hy-mt-1.5-7b',
        timeout: 300000, // 5 minutes
        temperature: 0.3, // Lower temp for translation consistency
    },
    google_model: {
        apiKey: process.env.GOOGLE_API_KEY,
        modelName: 'gemini-3-flash-preview',
        timeout: 1200000,
        temperature: 0.9
    },
    groq_model: {
        apiKey: process.env.GROQ_API_KEY,
        modelName: 'llama-3.3-70b-versatile',
        timeout: 300000,
        temperature: 0.7
    }
};
