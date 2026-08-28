/**
 * What changed between two versions of a chunk.
 *
 * By words, not characters. A character diff of a paragraph where one word was
 * replaced marks the letters the two words happen to share and leaves a reader
 * assembling the answer out of fragments; by words the answer is the answer.
 * Whitespace travels as its own token, so what comes back out is exactly what
 * went in — a diff that cannot be reassembled into the original is a diff nobody
 * can trust to be complete.
 *
 * The common head and tail are taken off before anything is compared. In this
 * project the usual pair differs by one word in four thousand characters — a
 * replace, a fix on advice — and without that trim every such comparison would
 * fill a 600×600 table to rediscover that the first 300 words are identical.
 *
 * The remaining middle goes through Longest Common Subsequence, which is O(n·m)
 * in both time and memory. Two texts that share nothing and are long enough
 * would ask for a table too big to be worth building, so past a limit the answer
 * is the honest coarse one: this was replaced by that.
 */

/** Words and the whitespace between them, so a join restores the text exactly. */
function tokenize(text) {
    return String(text || '').match(/\s+|\S+/g) || [];
}

// 4 million cells. At two texts of 2000 words each this is the last size worth
// filling; beyond it the pair has nothing in common worth finding word by word.
const MAX_CELLS = 4_000_000;

/**
 * The edit script between two texts.
 *
 * @param {string} before
 * @param {string} after
 * @returns {Array<{op: 'same'|'del'|'ins', text: string}>}
 *   Runs, in order. Joining `same` and `del` gives back `before` exactly;
 *   joining `same` and `ins` gives back `after`.
 */
export function wordDiff(before, after) {
    const a = tokenize(before);
    const b = tokenize(after);

    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head
        && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

    const midA = a.slice(head, a.length - tail);
    const midB = b.slice(head, b.length - tail);

    const out = [];
    const push = (op, text) => {
        if (!text) return;
        const last = out[out.length - 1];
        if (last && last.op === op) last.text += text;
        else out.push({ op, text });
    };

    push('same', a.slice(0, head).join(''));

    if (midA.length && midB.length && midA.length * midB.length > MAX_CELLS) {
        push('del', midA.join(''));
        push('ins', midB.join(''));
    } else if (!midA.length || !midB.length) {
        push('del', midA.join(''));
        push('ins', midB.join(''));
    } else {
        // One row at a time: the table is only needed to walk back through, and
        // keeping every row is what makes a long pair expensive in memory rather
        // than only in time.
        const n = midA.length, m = midB.length;
        const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
        for (let i = n - 1; i >= 0; i--) {
            for (let j = m - 1; j >= 0; j--) {
                lcs[i][j] = midA[i] === midB[j]
                    ? lcs[i + 1][j + 1] + 1
                    : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
            }
        }
        let i = 0, j = 0;
        while (i < n && j < m) {
            if (midA[i] === midB[j]) { push('same', midA[i]); i++; j++; }
            else if (lcs[i + 1][j] >= lcs[i][j + 1]) { push('del', midA[i]); i++; }
            else { push('ins', midB[j]); j++; }
        }
        while (i < n) { push('del', midA[i]); i++; }
        while (j < m) { push('ins', midB[j]); j++; }
    }

    push('same', a.slice(a.length - tail).join(''));
    return out;
}

/**
 * The same, with the untouched stretches cut down to their ends.
 *
 * A chunk is four thousand characters and a change is usually one word. Shown
 * whole, the change is a needle; shown with `context` characters either side of
 * it, the change is the page.
 *
 * @returns {Array<{op: 'same'|'del'|'ins'|'gap', text?: string, chars?: number}>}
 *   A `gap` stands for what was left out and says how much that was.
 */
export function condense(runs, context = 90) {
    const out = [];
    runs.forEach((run, k) => {
        if (run.op !== 'same') { out.push(run); return; }
        const first = k === 0, last = k === runs.length - 1;
        // A short stretch between two changes is worth more whole than cut: the
        // cut would save nothing and cost the reader the thread.
        if (run.text.length <= context * 2 + 20) { out.push(run); return; }
        if (!first) out.push({ op: 'same', text: run.text.slice(0, context) });
        out.push({ op: 'gap', chars: run.text.length - (first ? 0 : context) - (last ? 0 : context) });
        if (!last) out.push({ op: 'same', text: run.text.slice(-context) });
    });
    return out;
}

/** How much a change added and removed, for a line that has no room for the text. */
export function diffSize(runs) {
    let added = 0, removed = 0;
    for (const run of runs) {
        if (run.op === 'ins') added += run.text.length;
        else if (run.op === 'del') removed += run.text.length;
    }
    return { added, removed };
}
