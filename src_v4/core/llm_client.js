import { ChatOpenAI } from "@langchain/openai";
import config from '../config.js';

class LLMClient {
    constructor() {
        this.clients = {
            logic: null,
            fast: null
        };
    }

    /**
     * Get or initialize the requested client type.
     * @param {'logic' | 'fast'} type 
     */
    getClient(type) {
        if (this.clients[type]) {
            return this.clients[type];
        }

        let conf;
        if (type === 'logic') {
            conf = config.logic_model;
        } else if (type === 'fast') {
            conf = config.fast_model;
        } else {
            throw new Error(`Unknown client type: ${type}`);
        }

        console.log(`[LLM] Initializing ${type} client at ${conf.baseUrl}...`);

        this.clients[type] = new ChatOpenAI({
            openAIApiKey: conf.apiKey,
            configuration: {
                baseURL: conf.baseUrl,
                timeout: conf.timeout,
            },
            modelName: conf.modelName,
            temperature: conf.temperature,
        });

        return this.clients[type];
    }
}

export const llmManager = new LLMClient();
