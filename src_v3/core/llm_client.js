import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatGroq } from "@langchain/groq";
import config from '../config.js';

class LLMClient {
    constructor() {
        this.clients = {
            logic: null,
            fast: null
        };
        this.provider = 'local'; // 'local' | 'google' | 'groq'
    }

    setProvider(provider) {
        if (provider !== 'local' && provider !== 'google' && provider !== 'groq') {
            throw new Error(`Invalid provider: ${provider}`);
        }
        this.provider = provider;
        // Reset clients to ensure correct one is created
        this.clients = { logic: null, fast: null };
        console.log(`[LLM] Provider set to: ${this.provider}`);
    }

    /**
     * Get or initialize the requested client type.
     * @param {'logic' | 'fast'} type 
     */
    getClient(type) {
        if (this.clients[type]) {
            return this.clients[type];
        }

        // Logic Model: Can be Local, Google, or Groq
        if (type === 'logic') {
            if (this.provider === 'google') {
                const conf = config.google_model;
                console.log(`[LLM] Initializing GOOGLE logic client (${conf.modelName})...`);
                this.clients[type] = new ChatGoogleGenerativeAI({
                    apiKey: conf.apiKey,
                    modelName: conf.modelName,
                    temperature: conf.temperature,
                    maxOutputTokens: 8192,
                });
                return this.clients[type];
            } else if (this.provider === 'groq') {
                const conf = config.groq_model;
                console.log(`[LLM] Initializing GROQ logic client (${conf.modelName})...`);
                this.clients[type] = new ChatGroq({
                    apiKey: conf.apiKey,
                    model: conf.modelName,
                    temperature: conf.temperature,
                });
                return this.clients[type];
            }

            // Fallback to local for 'local' provider
            const conf = config.logic_model;
            console.log(`[LLM] Initializing LOCAL logic client at ${conf.baseUrl}...`);
            this.clients[type] = new ChatOpenAI({
                openAIApiKey: conf.apiKey,
                configuration: { baseURL: conf.baseUrl },
                timeout: conf.timeout,
                maxRetries: 0,
                modelName: conf.modelName,
                temperature: conf.temperature,
            });
            return this.clients[type];
        }

        // Fast Model: Always Local for now (unless we want to use Flash)
        // For simple switching, let's keep 'fast' as configured in config.js (usually local)
        // unless explicitly requested otherwise. V4 primarily uses 'logic'.
        if (type === 'fast') {
            const conf = config.fast_model;
            console.log(`[LLM] Initializing LOCAL fast client at ${conf.baseUrl}...`);
            this.clients[type] = new ChatOpenAI({
                openAIApiKey: conf.apiKey,
                configuration: { baseURL: conf.baseUrl },
                timeout: conf.timeout,
                maxRetries: 0,
                modelName: conf.modelName,
                temperature: conf.temperature,
            });
            return this.clients[type];
        }

        throw new Error(`Unknown client type: ${type}`);
    }
}

export const llmManager = new LLMClient();
