import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatGroq } from "@langchain/groq";
import config from '../config.js';
import { RateLimiter } from '../utils/rate_limiter.js';

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

        let rawClient;
        let rpm = 0;

        // Logic Model: Can be Local, Google, or Groq
        if (type === 'logic') {
            if (this.provider === 'google') {
                const conf = config.google_model;
                rpm = conf.maxRPM || 0;
                console.log(`[LLM] Initializing GOOGLE logic client (${conf.modelName}) with RPM=${rpm}...`);
                rawClient = new ChatGoogleGenerativeAI({
                    apiKey: conf.apiKey,
                    modelName: conf.modelName,
                    temperature: conf.temperature,
                    maxOutputTokens: 8192,
                });
            } else if (this.provider === 'groq') {
                const conf = config.groq_model;
                rpm = conf.maxRPM || 0;
                console.log(`[LLM] Initializing GROQ logic client (${conf.modelName}) with RPM=${rpm}...`);
                rawClient = new ChatGroq({
                    apiKey: conf.apiKey,
                    model: conf.modelName,
                    temperature: conf.temperature,
                });
            } else {
                // Fallback to local
                const conf = config.logic_model;
                rpm = conf.maxRPM || 0;
                console.log(`[LLM] Initializing LOCAL logic client at ${conf.baseUrl} with RPM=${rpm}...`);
                rawClient = new ChatOpenAI({
                    openAIApiKey: conf.apiKey,
                    configuration: { baseURL: conf.baseUrl },
                    timeout: conf.timeout,
                    maxRetries: 0,
                    modelName: conf.modelName,
                    temperature: conf.temperature,
                });
            }
        }
        // Fast Model: Always Local for now
        else if (type === 'fast') {
            const conf = config.fast_model;
            rpm = conf.maxRPM || 0;
            console.log(`[LLM] Initializing LOCAL fast client at ${conf.baseUrl} with RPM=${rpm}...`);
            rawClient = new ChatOpenAI({
                openAIApiKey: conf.apiKey,
                configuration: { baseURL: conf.baseUrl },
                timeout: conf.timeout,
                maxRetries: 0,
                modelName: conf.modelName,
                temperature: conf.temperature,
            });
        } else {
            throw new Error(`Unknown client type: ${type}`);
        }

        // Wrap with Rate Limiter
        const limiter = new RateLimiter(rpm);

        // Proxy to intercept 'invoke' calls
        this.clients[type] = new Proxy(rawClient, {
            get(target, prop, receiver) {
                if (prop === 'invoke') {
                    return async function (...args) {
                        await limiter.waitForToken();
                        return target.invoke(...args);
                    };
                }
                return Reflect.get(target, prop, receiver);
            }
        });

        return this.clients[type];
    }
}

export const llmManager = new LLMClient();
