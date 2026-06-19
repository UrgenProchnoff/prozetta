/**
 * Per-project accounting of real LLM spend: number of calls and tokens used.
 *
 * The pipeline runs as a single child process per stage, so a module-level
 * singleton is enough. `llm_client` records into it after every invoke; the
 * `state_manager` seeds it with the totals already stored in the project JSON
 * (the baseline) on load and snapshots the merged result back into
 * `metadata.usage` on save. Because the session counters are monotonic, the
 * baseline+session merge is idempotent across the repeated saves in one run.
 */

function emptyTotals() {
    return {
        totalCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        byStage: {},   // stage label -> bucket
        byModel: {},   // "provider/model" -> bucket
    };
}

function emptyBucket() {
    return { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

// Coerce a possibly-partial persisted object into a well-formed totals object.
function normalize(u) {
    const out = emptyTotals();
    if (!u || typeof u !== 'object') return out;
    out.totalCalls = num(u.totalCalls);
    out.inputTokens = num(u.inputTokens);
    out.outputTokens = num(u.outputTokens);
    out.totalTokens = num(u.totalTokens) || out.inputTokens + out.outputTokens;
    for (const dim of ['byStage', 'byModel']) {
        const src = u[dim];
        if (src && typeof src === 'object') {
            for (const key of Object.keys(src)) {
                const b = src[key] || {};
                out[dim][key] = {
                    calls: num(b.calls),
                    inputTokens: num(b.inputTokens),
                    outputTokens: num(b.outputTokens),
                    totalTokens: num(b.totalTokens) || num(b.inputTokens) + num(b.outputTokens),
                };
            }
        }
    }
    return out;
}

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function bumpBucket(map, key, i, o, t) {
    const b = map[key] || (map[key] = emptyBucket());
    b.calls += 1;
    b.inputTokens += i;
    b.outputTokens += o;
    b.totalTokens += t;
}

// merged = a + b (per top-level counter and per bucket)
function mergeTotals(a, b) {
    const out = emptyTotals();
    out.totalCalls = a.totalCalls + b.totalCalls;
    out.inputTokens = a.inputTokens + b.inputTokens;
    out.outputTokens = a.outputTokens + b.outputTokens;
    out.totalTokens = a.totalTokens + b.totalTokens;
    for (const dim of ['byStage', 'byModel']) {
        for (const src of [a[dim], b[dim]]) {
            for (const key of Object.keys(src)) {
                const s = src[key];
                const d = out[dim][key] || (out[dim][key] = emptyBucket());
                d.calls += s.calls;
                d.inputTokens += s.inputTokens;
                d.outputTokens += s.outputTokens;
                d.totalTokens += s.totalTokens;
            }
        }
    }
    return out;
}

class UsageTracker {
    constructor() {
        this.baseline = emptyTotals();
        this.session = emptyTotals();
        this.currentStage = 'unknown';
        this.firstSeen = null; // when this project first recorded any spend
    }

    /** Seed with the totals already persisted in the project JSON. */
    setBaseline(usage) {
        this.baseline = normalize(usage);
        if (usage && usage.firstSeen) this.firstSeen = usage.firstSeen;
    }

    /** Label subsequent calls by pipeline operation: extraction/consolidation/translate/check/fix. */
    setStage(stage) {
        this.currentStage = stage || 'unknown';
    }

    record({ provider, model, inputTokens = 0, outputTokens = 0, totalTokens = 0 } = {}) {
        inputTokens = num(inputTokens);
        outputTokens = num(outputTokens);
        totalTokens = num(totalTokens) || inputTokens + outputTokens;

        this.session.totalCalls += 1;
        this.session.inputTokens += inputTokens;
        this.session.outputTokens += outputTokens;
        this.session.totalTokens += totalTokens;
        bumpBucket(this.session.byStage, this.currentStage, inputTokens, outputTokens, totalTokens);
        bumpBucket(this.session.byModel, `${provider || '?'}/${model || '?'}`, inputTokens, outputTokens, totalTokens);

        if (!this.firstSeen) this.firstSeen = new Date().toISOString();
    }

    get hasData() { return this.session.totalCalls > 0; }
    get hasBaseline() { return this.baseline.totalCalls > 0; }

    /** Baseline + this session, ready to persist into metadata.usage. */
    snapshot() {
        const merged = mergeTotals(this.baseline, this.session);
        merged.firstSeen = this.firstSeen;
        merged.updatedAt = new Date().toISOString();
        return merged;
    }

    /** Compact one-liner for per-chunk progress logging during a long run. */
    sessionLine() {
        if (!this.hasData) return '';
        const s = this.session;
        return `[Tokens] run: ${fmt(s.totalCalls)} calls · ${fmt(s.totalTokens)} tok · project: ${fmt(this.baseline.totalTokens + s.totalTokens)} tok`;
    }

    /**
     * Human-readable terminal report: what this run spent, the per-operation
     * breakdown, and the running project total. Returns '' if nothing was spent
     * and there is no prior history to report.
     */
    formatReport() {
        if (!this.hasData && !this.hasBaseline) return '';
        const s = this.session;
        const total = this.snapshot();
        const lines = [];
        lines.push('===== TOKEN USAGE =====');
        if (this.hasData) {
            lines.push(`This run:    ${fmt(s.totalCalls)} calls · in ${fmt(s.inputTokens)} · out ${fmt(s.outputTokens)} · total ${fmt(s.totalTokens)} tokens`);
            const stages = Object.keys(s.byStage).sort((a, b) => s.byStage[b].totalTokens - s.byStage[a].totalTokens);
            for (const st of stages) {
                const b = s.byStage[st];
                lines.push(`  - ${st.padEnd(14)} ${fmt(b.calls)} calls · ${fmt(b.totalTokens)} tokens`);
            }
        } else {
            lines.push('This run:    no model calls');
        }
        lines.push(`Project total: ${fmt(total.totalCalls)} calls · in ${fmt(total.inputTokens)} · out ${fmt(total.outputTokens)} · total ${fmt(total.totalTokens)} tokens`);
        lines.push('=======================');
        return lines.join('\n');
    }
}

// 1234567 → "1 234 567" (thin-space grouping, locale-independent for logs)
function fmt(n) {
    return String(num(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export const usageTracker = new UsageTracker();
