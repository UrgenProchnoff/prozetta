/**
 * Bringing a glossary over from another book of the same series.
 *
 * The point is consistency across books: the second volume has to call the
 * subpersonalities and the rebels what the first one did, and a glossary
 * extracted afresh promises nothing of the kind. So the series' renderings are
 * offered first, and a person settles every clash.
 *
 * Only entries the new book actually uses come across — found the way the
 * cheat sheet finds them (entryRegex) — with one exception: a clone brings its
 * prime, because a link to an entry that is not there is a broken link.
 *
 * Whatever is in the glossary when consolidation runs stays: it keeps the
 * glossary it finds and skips the terms already in it. So a re-extraction after
 * an import neither overwrites nor pays for the series' entries.
 *
 * Pure: no files, no state. The server feeds it, the editor applies the result.
 */

import { entryRegex } from './text_stats.js';
import { resolveLinks } from './glossary_links.js';

const keyOf = (entry) => String(entry?.original || '').toLowerCase().trim();
const same = (a, b) => String(a || '').trim() === String(b || '').trim();

/**
 * @param {Array<object>} current   this book's glossary
 * @param {Array<object>} incoming  the other book's glossary
 * @param {string} bookText         this book's original text
 * @returns {{
 *   add: Array<object>,
 *   conflicts: Array<{index: number, original: string, current: object, incoming: object}>,
 *   fill: Array<{index: number, fields: object}>,
 *   same: number, absent: number, primes: number
 * }}
 *   `add` — new entries, in the other glossary's order; `conflicts` — the same
 *   original rendered differently, `index` into `current`; `fill` — the same
 *   rendering, with gender or notes this glossary left empty; `same` — nothing
 *   to do; `absent` — not in this book, left out; `primes` — brought only to
 *   keep a clone's link whole.
 */
export function planImport(current, incoming, bookText) {
    const mine = Array.isArray(current) ? current : [];
    const theirs = (Array.isArray(incoming) ? incoming : []).filter(e => keyOf(e));
    const text = String(bookText || '');

    const index = new Map();
    mine.forEach((e, i) => { if (keyOf(e) && !index.has(keyOf(e))) index.set(keyOf(e), i); });

    const occurs = theirs.map(e => {
        try { return entryRegex(e).test(text); } catch { return false; }
    });

    // A clone in the book pulls its prime in with it.
    const { prime } = resolveLinks(theirs);
    const wanted = occurs.slice();
    let primes = 0;
    theirs.forEach((_, i) => {
        const p = prime[i];
        if (wanted[i] && p != null && !wanted[p]) { wanted[p] = true; primes++; }
    });

    const plan = { add: [], conflicts: [], fill: [], same: 0, absent: 0, primes };
    const seen = new Set();
    theirs.forEach((e, i) => {
        const key = keyOf(e);
        if (seen.has(key)) return;
        seen.add(key);
        if (!wanted[i]) { plan.absent++; return; }

        const at = index.get(key);
        if (at === undefined) { plan.add.push({ ...e }); return; }

        const mineEntry = mine[at];
        if (!same(mineEntry.translation, e.translation)) {
            plan.conflicts.push({ index: at, original: mineEntry.original, current: mineEntry, incoming: e });
            return;
        }
        const fields = {};
        if (!mineEntry.gender && e.gender) fields.gender = e.gender;
        if (!String(mineEntry.notes || '').trim() && String(e.notes || '').trim()) fields.notes = e.notes;
        if (Object.keys(fields).length) plan.fill.push({ index: at, fields });
        else plan.same++;
    });
    return plan;
}
