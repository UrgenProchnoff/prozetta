export default {
    logic_model: {
        baseUrl: 'http://127.0.0.1:8007/v1',
        apiKey: 'sk-no-key-required', // Usually local servers don't need keys
        modelName: 'qwen3-80b-instruct', // Placeholder, important for headers but often ignored by local server
        timeout: 600000, // 10 minutes
        temperature: 0.7,
    },
    fast_model: {
        baseUrl: 'http://127.0.0.1:8008/v1',
        apiKey: 'sk-no-key-required',
        modelName: 'hy-mt-1.5-7b',
        timeout: 300000, // 5 minutes
        temperature: 0.3, // Lower temp for translation consistency
    }
};
