/**
 * Simple Rate Limiter to prevent API 429 errors.
 * Uses a token bucket-like pause mechanism.
 */
export class RateLimiter {
    /**
     * @param {number} rpm Requests Per Minute
     */
    constructor(rpm) {
        this.rpm = rpm || 0;
        this.lastRequestTime = 0;
        this.delayMs = rpm > 0 ? (60000 / rpm) : 0;
    }

    /**
     * Wait for token. Call this BEFORE invoking the LLM.
     */
    async waitForToken() {
        if (this.rpm <= 0) return; // No limit

        const now = Date.now();
        const timeSinceLast = now - this.lastRequestTime;

        if (timeSinceLast < this.delayMs) {
            const waitTime = this.delayMs - timeSinceLast;
            // Add a small jitter (10ms)
            await new Promise(resolve => setTimeout(resolve, waitTime + 10));
        }

        this.lastRequestTime = Date.now();
    }

    /**
     * Update RPM on the fly if needed
     * @param {number} newRPM 
     */
    updateRPM(newRPM) {
        this.rpm = newRPM;
        this.delayMs = newRPM > 0 ? (60000 / newRPM) : 0;
    }
}
