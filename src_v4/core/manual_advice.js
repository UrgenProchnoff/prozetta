/**
 * Advice a person writes, queued the way accepted review findings are.
 *
 * The whole-book review is not the only reader who notices things: whoever
 * proofreads the translation finds the same kinds of fault — a narrator's
 * gender agreement gone wrong in one scene, a name rendered two ways across a
 * dozen chapters — and had no way to hand them to the translator except
 * editing every chunk by hand. A piece of manual advice goes into the same
 * per-chunk queue a finding does, so the next translation run fixes it with
 * the same fix-and-check loop, and the queue shows and removes it the same way.
 *
 * Only chunks that already have a translation can take advice: the loop acts on
 * advice by fixing the existing text, and with no text there is nothing to fix.
 */

/** Marks advice a person wrote, as opposed to a review finding's key. */
export const MANUAL_PREFIX = 'manual|';

/** A key shared by every chunk one piece of advice was queued on. */
export function manualKey(now = Date.now()) {
    return `${MANUAL_PREFIX}${now.toString(36)}`;
}

export function isManual(key) {
    return String(key || '').startsWith(MANUAL_PREFIX);
}

/**
 * Chunk numbers as a person types them — "3, 7-12, 40", 1-based — as indices.
 *
 * @returns {{indices: number[], bad: string[]}} indices sorted and unique;
 *   `bad` holds the pieces that are not a number or range inside the book.
 */
export function parseChunkList(spec, total) {
    const indices = new Set();
    const bad = [];
    for (const raw of String(spec || '').split(/[,;\s]+/)) {
        const part = raw.trim();
        if (!part) continue;
        const m = /^(\d+)(?:\s*[-–—]\s*(\d+))?$/.exec(part);
        if (!m) { bad.push(part); continue; }
        let from = Number(m[1]), to = Number(m[2] ?? m[1]);
        if (from > to) [from, to] = [to, from];
        if (from < 1 || to > total) { bad.push(part); continue; }
        for (let n = from; n <= to; n++) indices.add(n - 1);
    }
    return { indices: [...indices].sort((a, b) => a - b), bad };
}

/**
 * Chunks whose translation (or original) contains `text`, case aside.
 *
 * Whitespace is matched loosely, since books arrive hard-wrapped: a phrase typed
 * on one line is found where the text breaks it across two.
 */
export function chunksContaining(chunks, text, where = 'translation') {
    const needle = String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
    if (!needle) return [];
    const field = where === 'original' ? 'original' : 'translation';
    const out = [];
    (chunks || []).forEach((chunk, i) => {
        const hay = String(chunk?.[field] || '').replace(/\s+/g, ' ').toLowerCase();
        if (hay.includes(needle)) out.push(i);
    });
    return out;
}
