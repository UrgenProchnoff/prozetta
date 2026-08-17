/**
 * Learning a language profile from a model, and refusing to believe it until it
 * has been checked against the text.
 *
 * The built-in tables cover the languages that were to hand. Everything else got
 * either English tables (Polish read as first person because "i" means "and") or
 * nothing at all. A model knows Dutch and Korean grammar better than a
 * hand-written table ever will — but it is also the component that has been
 * caught in this pipeline misquoting a source to justify a claim, so its answer
 * is treated as a proposal, not as fact.
 *
 * Two properties make that safe:
 *   - the model supplies WORD LISTS and characters, never regexes, so the code
 *     keeps control of matching (and of the \b-versus-Unicode trap that made the
 *     Russian table count zero pronouns for months);
 *   - every claim is checkable against the very text that prompted the question:
 *     words it says are frequent must actually be frequent, quotes it says mark
 *     speech must actually find speech.
 *
 * A profile is per LANGUAGE, not per book, so it is learned once and stored in a
 * shared file that accumulates and can be hand-edited like the glossary.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { HumanMessage } from '@langchain/core/messages';
import { extractJson } from '../utils/parsers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const LEARNED_PROFILES_PATH = path.join(__dirname, '..', 'language_profiles.json');

const WORD_EDGE = '[\\p{L}\\p{N}]';

/** Count how many of `list`'s words occur in the text, as whole words. */
function countWords(text, list) {
    const items = String(list || '').split(/\s+/).filter(Boolean);
    if (!items.length) return 0;
    const escaped = items
        .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .sort((a, b) => b.length - a.length);
    const re = new RegExp(`(?<!${WORD_EDGE})(?:${escaped.join('|')})(?!${WORD_EDGE})`, 'giu');
    return (text.match(re) || []).length;
}

function wordSet(list) {
    return new Set(String(list || '').toLowerCase().split(/\s+/).filter(Boolean));
}

/**
 * Check a proposed profile against the text it was derived from.
 *
 * Every threshold below is a measurement, not a preference: function words run
 * 14–21% of all words in a language the table actually knows, and a mismatched
 * language sat at 6.8%; the pronoun floor is the same one the gender heuristic
 * uses to decide it has enough evidence to speak.
 *
 * @returns {{ok: boolean, checks: Array<{name: string, ok: boolean, detail: string}>}}
 */
export function validateLanguageProfile(profile, text) {
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok, detail });

    const words = String(text || '').toLowerCase().match(/[\p{L}]+/gu) || [];
    const total = words.length;

    add('language code', /^[a-z]{2,3}$/.test(String(profile?.language || '').toLowerCase()),
        `"${profile?.language}"`);

    // 1. Function words must actually be frequent in this text.
    const fwHits = countWords(text, profile?.functionWords);
    const fwShare = total ? fwHits / total : 0;
    add('function words are frequent', fwShare >= 0.08,
        `${(100 * fwShare).toFixed(1)}% of words (floor 8%)`);

    // 2. Pronouns must occur — but which persons occur is a property of the
    //    text, not of the profile. A third-person narrative barely says "I" or
    //    "you": a correct Dutch profile was rejected by an earlier "two persons
    //    out of three" rule on a sample with 31 third-person pronouns and 2 of
    //    each other kind. What a wrong profile looks like is all three lists at
    //    zero, so the union is what gets tested, plus one person carrying real
    //    weight.
    const persons = ['first', 'second', 'third'];
    const hits = Object.fromEntries(persons.map(p => [p, countWords(text, profile?.pronouns?.[p])]));
    const union = hits.first + hits.second + hits.third;
    const unionShare = total ? union / total : 0;
    add('pronouns occur in the text', unionShare >= 0.005 && Math.max(...Object.values(hits)) >= 3,
        `${persons.map(p => `${p}: ${hits[p]}`).join(', ')} — ${(100 * unionShare).toFixed(1)}% of words`);

    // 3. A word claimed for two persons at once makes both counts meaningless.
    const overlaps = [];
    for (let i = 0; i < persons.length; i++) {
        for (let j = i + 1; j < persons.length; j++) {
            const a = wordSet(profile?.pronouns?.[persons[i]]);
            const b = wordSet(profile?.pronouns?.[persons[j]]);
            for (const w of a) if (b.has(w)) overlaps.push(`${w} (${persons[i]}/${persons[j]})`);
        }
    }
    add('persons do not overlap', overlaps.length === 0, overlaps.slice(0, 5).join(', ') || 'no overlap');

    // 4. Entries must be single words: a phrase would never match, and a regex
    //    fragment would be silently escaped into nonsense.
    const allEntries = [profile?.functionWords, ...persons.map(p => profile?.pronouns?.[p]),
        profile?.gender?.masculine, profile?.gender?.feminine]
        .flatMap(l => String(l || '').split(/\s+/).filter(Boolean));
    const malformed = allEntries.filter(w => w.length > 20 || /[.*+?^${}()|[\]\\]/.test(w));
    add('entries are plain words', malformed.length === 0, malformed.slice(0, 3).join(', ') || 'all clean');

    // 5. Gender pronouns: either both sides occur, or the language is declared
    //    not to mark gender. One side alone cannot distinguish anything.
    const masc = countWords(text, profile?.gender?.masculine);
    const fem = countWords(text, profile?.gender?.feminine);
    const genderClaimed = !!(String(profile?.gender?.masculine || '').trim() || String(profile?.gender?.feminine || '').trim());
    add('gender pronouns usable', !genderClaimed || (masc >= 3 && fem >= 3),
        genderClaimed ? `masculine ${masc}, feminine ${fem}` : 'not claimed');

    // 6. Quote marks must find speech — unless the sample genuinely has none,
    //    which shows up as no quote characters of any kind in the text.
    const pairs = Array.isArray(profile?.quotePairs) ? profile.quotePairs : [];
    const anyQuoteChar = /["'«»„“”‘’「」『』]/u.test(text);
    let quoted = 0;
    for (const pair of pairs) {
        if (!Array.isArray(pair) || pair.length !== 2) continue;
        const [o, c] = pair.map(x => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        if (!o || !c) continue;
        quoted += (text.match(new RegExp(`${o}[^${c}]{0,600}${c}`, 'gu')) || []).length;
    }
    add('quote marks find speech', !anyQuoteChar || quoted > 0,
        anyQuoteChar ? `${quoted} quoted spans` : 'sample has no quotes at all');

    // 7. Sentence terminators must occur, or nothing downstream can scope by
    //    sentence.
    const enders = String(profile?.sentenceEnd || '');
    const enderHits = enders ? [...enders].reduce((n, ch) => n + (text.split(ch).length - 1), 0) : 0;
    add('sentence enders occur', enderHits > 0, `${enderHits} occurrences of "${enders}"`);

    return { ok: checks.every(c => c.ok), checks };
}

/** Ask the model for a profile of the language this text is written in. */
export async function learnLanguageProfile(client, prompts, text, sampleChars = 6000) {
    // A sample from the middle avoids title pages and tables of contents, which
    // are often in a different language from the book.
    const start = Math.max(0, Math.floor(text.length / 3));
    const sample = text.slice(start, start + sampleChars);

    const response = await client.invoke([
        new HumanMessage(prompts.languageProfile.system()),
        new HumanMessage(prompts.languageProfile.user(sample)),
    ]);
    return extractJson(response.content || '');
}

export function loadLearnedProfiles() {
    if (!fs.existsSync(LEARNED_PROFILES_PATH)) return {};
    try {
        return JSON.parse(fs.readFileSync(LEARNED_PROFILES_PATH, 'utf-8'));
    } catch (e) {
        console.warn(`[Language] Could not read ${path.basename(LEARNED_PROFILES_PATH)}: ${e.message}`);
        return {};
    }
}

/**
 * Store a validated profile. Written whole so the file stays hand-editable: it
 * is data, and a human who disagrees with the model should be able to fix a
 * pronoun list without touching code.
 */
export function saveLearnedProfile(lang, profile) {
    const all = loadLearnedProfiles();
    all[lang] = { ...profile, learnedAt: new Date().toISOString() };
    const tmp = `${LEARNED_PROFILES_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
    fs.renameSync(tmp, LEARNED_PROFILES_PATH);
    return all[lang];
}
