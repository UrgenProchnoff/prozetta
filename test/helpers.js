import fs from 'fs';
import os from 'os';
import path from 'path';
import { mock } from 'node:test';

/** A throwaway working directory, removed when the test file finishes. */
export function tempWorkDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prozetta-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

/**
 * The pipeline narrates everything it does. Under test that is noise around the
 * one line that matters, so it is swallowed — and kept, for a test that wants
 * to assert on what was said.
 */
export function silenceConsole() {
    const lines = [];
    for (const method of ['log', 'warn', 'error']) {
        mock.method(console, method, (...args) => { lines.push(args.join(' ')); });
    }
    return lines;
}

/** A check answer the way a model writes one. */
export function verdict({ score = 10, like = 1, error = 0, misspell = 0, correctness = 1, comment = 'ok' } = {}) {
    return JSON.stringify({ error, misspell, correctness, like, score, comment });
}

/** A translate/fix answer the way a model writes one. */
export function answer(text, comment = '') {
    return `<translate>${text}</translate><comment>${comment}</comment>`;
}
