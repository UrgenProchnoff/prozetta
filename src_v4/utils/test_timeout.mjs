// Quick test to verify timeout behavior
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";

const TIMEOUT = 4000000; // 67 minutes

console.log(`Creating ChatOpenAI with timeout=${TIMEOUT}ms (${Math.round(TIMEOUT / 60000)} min)`);

const model = new ChatOpenAI({
    apiKey: "sk-no-key-required",
    configuration: {
        baseURL: "http://127.0.0.1:8007/v1",
        timeout: TIMEOUT,
        maxRetries: 0,
    },
    timeout: TIMEOUT,
    maxRetries: 0,
    modelName: "qwen3.5-35b",
    temperature: 0.6,
});

// Also check: does the bare openai SDK work?
console.log(`model.timeout = ${model.timeout}`);
console.log(`model.clientConfig.timeout = ${model.clientConfig?.timeout}`);

const start = Date.now();
console.log(`Sending request at ${new Date().toISOString()}...`);

try {
    const result = await model.invoke([new HumanMessage("Say hello in Russian. Be brief.")]);
    const elapsed = Date.now() - start;
    console.log(`SUCCESS in ${Math.round(elapsed / 1000)}s: ${result.content}`);
} catch (e) {
    const elapsed = Date.now() - start;
    console.log(`FAILED after ${Math.round(elapsed / 1000)}s (${Math.round(elapsed / 60000)} min): ${e.message}`);
}
