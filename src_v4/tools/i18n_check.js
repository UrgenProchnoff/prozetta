/**
 * The interface dictionary against the interface.
 *
 * Two questions, both of which went unanswered until strings started rotting:
 * does every key the code asks for exist in both languages, and does every key
 * in the dictionary get asked for by anything?
 *
 * The second is the one that bit. 468 keys had accumulated and 17 of them
 * belonged to a stage dropdown and a settings layout that no longer exist —
 * dead weight nobody could tell from live weight by looking, and every edit to
 * the dictionary carried it along.
 *
 * A key is live when it is named outright, or when something builds it at run
 * time. Three forms of building are in use, and all three have to be recognised
 * or the tool reports live strings as dead:
 *
 *   t('status.' + s)              — a prefix and a variable
 *   t(`usage.stage.${stage}`)     — a template, sometimes assigned first
 *   t('gloss.rv_' + action)       — a prefix that is not a dotted path
 *
 * Run: npm run i18n
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src_gui', 'web');

/** Keys declared under one language, in order. */
function keysOf(text) {
    return [...text.matchAll(/^\s{12}'([\w.]+)':/gm)].map(m => m[1]);
}

function main() {
    const dict = fs.readFileSync(path.join(WEB, 'i18n.js'), 'utf8');
    const code = ['app.js', 'index.html']
        .map(f => { try { return fs.readFileSync(path.join(WEB, f), 'utf8'); } catch { return ''; } })
        .join('\n');

    const start = dict.indexOf('const MESSAGES = {');
    const ruAt = dict.indexOf('        ru: {', start);
    const enAt = dict.indexOf('        en: {', start);
    if (start < 0 || ruAt < 0 || enAt < 0) {
        console.error('[i18n] Could not find the MESSAGES blocks — has the file been restructured?');
        process.exitCode = 1;
        return;
    }
    const ru = keysOf(dict.slice(ruAt, enAt));
    const en = keysOf(dict.slice(enAt));

    const problems = [];

    // --- 1. the two languages must carry the same keys ---
    const onlyRu = ru.filter(k => !en.includes(k));
    const onlyEn = en.filter(k => !ru.includes(k));
    if (onlyRu.length) problems.push(`missing from en: ${onlyRu.join(', ')}`);
    if (onlyEn.length) problems.push(`missing from ru: ${onlyEn.join(', ')}`);

    const dupes = (list, lang) => {
        const seen = new Set(), twice = new Set();
        for (const k of list) (seen.has(k) ? twice : seen).add(k);
        if (twice.size) problems.push(`declared twice in ${lang}: ${[...twice].join(', ')}`);
    };
    dupes(ru, 'ru'); dupes(en, 'en');

    // --- 2. every key the code asks for must exist ---
    const literal = new Set([...code.matchAll(/\bt\(\s*['"`]([\w.]+)['"`]\s*[),]/g)].map(m => m[1]));
    const missing = [...literal].filter(k => !ru.includes(k));
    if (missing.length) problems.push(`asked for but not in the dictionary: ${missing.join(', ')}`);

    // --- 3. every key in the dictionary must be asked for ---
    const built = [
        ...[...code.matchAll(/\b(?:t|tr)\(\s*['"`]([\w.]*[._])['"`]\s*(?:\+|,)/g)].map(m => m[1]),
        ...[...code.matchAll(/[`']([\w.]*[._])\$\{/g)].map(m => m[1]),
    ];
    const prefixes = [...new Set(built)].filter(Boolean);
    const dead = ru.filter(k => !literal.has(k) && !prefixes.some(p => k.startsWith(p)));
    if (dead.length) problems.push(`in the dictionary but nothing asks for them:\n    ${dead.join('\n    ')}`);

    if (!problems.length) {
        console.log(`[i18n] ${ru.length} key(s), both languages in step, none dead.`);
        return;
    }
    for (const p of problems) console.error(`[i18n] ${p}`);
    console.error(`\n[i18n] ${problems.length} problem(s).`);
    process.exitCode = 1;
}

main();
