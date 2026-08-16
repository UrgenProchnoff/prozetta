/**
 * Deterministic measurements over the source text.
 *
 * These answer questions a language model answers worse and charges for. Both
 * were calibrated against known answers:
 *   - narrative person: right on 3 of 3 books;
 *   - gender from pronouns: 14 right, 0 wrong, 2 abstentions out of 16 names.
 * Whatever they can settle should not be asked of a model; what they cannot
 * settle should be handed to it as evidence rather than left for it to re-derive.
 *
 * Everything script-specific — pronouns, sentence ends, quote marks — comes from
 * language.js, and each result carries `supported` so an unsupported script
 * reads as "not measured" rather than as "measured as nothing".
 */

import { profileForText, quotedSpeechRegex } from './language.js';

const WORD = '[\\p{L}\\p{N}]';

// Scripts written without spaces between words. A boundary assertion next to
// one of these can never hold: 魏婴 is always flanked by more Han characters,
// which are letters too, so requiring a non-letter neighbour finds 1 of its 5
// occurrences and 0 of 江厌离's 2. For these scripts a plain substring match is
// the correct behaviour, not a fallback.
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;

/**
 * Match a term as a whole word, per side.
 *
 * The assertion is dropped only on the side whose own character belongs to an
 * unspaced script, so a Latin term inside a Chinese text still gets its
 * boundaries and a mixed term gets one of each.
 */
export function wholeWordRegex(term, flags = 'giu') {
    const text = String(term);
    const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const left = UNSPACED_SCRIPT.test(text[0] || '') ? '' : `(?<!${WORD})`;
    const right = UNSPACED_SCRIPT.test(text[text.length - 1] || '') ? '' : `(?!${WORD})`;
    return new RegExp(`${left}${escaped}${right}`, flags);
}

export function countOccurrences(text, term) {
    return (text.match(wholeWordRegex(term)) || []).length;
}

/**
 * Drop quoted speech. "I" and "you" fill dialogue no matter how the narration
 * is written, so they have to go before any pronoun is counted.
 */
export function stripDialogue(text, profile = profileForText(text)) {
    return String(text).replace(quotedSpeechRegex(profile), ' ');
}

/**
 * Whether the book is narrated in first, second or third person.
 *
 * The first question worth asking, because it says whether there is a problem at
 * all: third-person narration names its characters, so gender comes off the
 * page, while first and second person hide the narrator's identity for chapters
 * at a time.
 *
 * @returns {{person: 'first'|'second'|'third'|null, counts: object, share: number,
 *            script: string, supported: boolean}}
 *   `supported: false` means the source script has no pronoun table here, and
 *   `person: null` is "not measured" rather than "measured as nothing" — a
 *   distinction the caller has to keep, or an unsupported language silently
 *   looks like a book with no pronouns in it.
 */
export function detectNarrativePerson(text) {
    const profile = profileForText(text);
    const empty = { first: 0, second: 0, third: 0 };
    if (!profile.supports.narrativePerson || !profile.person) {
        return { person: null, counts: empty, share: 0, script: profile.script, supported: false };
    }

    const narration = stripDialogue(text, profile).toLowerCase();
    const count = re => (narration.match(new RegExp(re.source, re.flags)) || []).length;
    const counts = {
        first: count(profile.person.first),
        second: count(profile.person.second),
        third: count(profile.person.third),
    };
    const total = counts.first + counts.second + counts.third;
    if (!total) return { person: null, counts, share: 0, script: profile.script, supported: true };

    const [person, best] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return { person, counts, share: best / total, script: profile.script, supported: true };
}

/**
 * Gender of a name from the pronouns that follow it across the whole book.
 * A single chunk rarely shows it; the book as a whole shows it clearly.
 *
 * In European prose counting stops at the end of the sentence rather than after
 * a fixed number of characters: a wider window picks up the pronouns of whoever
 * is mentioned next and starts assigning genders to places. Measured on 16 names
 * with a known answer, sentence scope gives 14 right, 0 wrong, 2 abstentions; a
 * 120-character window gets 2 of them wrong. Chinese, Japanese and Korean run
 * topic chains where the pronoun lands in the *next* sentence, so their profiles
 * ask for a plain window instead — see genderScope in language.js.
 *
 * Reliable on frequently mentioned bare names, unreliable on titled forms
 * ("Ms. Barnaby") and place names — so callers should treat `gender` as a hint
 * and keep the counts around to show how much evidence is behind it.
 *
 * Scope is measured in characters, which suits scripts where a character is
 * roughly a letter. In Han and kana a character is closer to a word, so the cap
 * scales down with the script — 200 Han characters is a page, not a sentence.
 *
 * @returns {{gender: 'm'|'f'|null, masculine: number, feminine: number, supported: boolean}}
 */
export function genderFromPronouns(text, name, maxScope = null) {
    const profile = profileForText(text);
    if (!profile.supports.gender || !profile.gender) {
        return { gender: null, masculine: 0, feminine: 0, supported: false };
    }
    const scopeCap = maxScope ?? (profile.spaced ? 200 : 60);

    const re = wholeWordRegex(name);
    let m, masculine = 0, feminine = 0;
    while ((m = re.exec(text)) !== null) {
        const after = text.slice(m.index + m[0].length);
        const sentenceEnd = profile.genderScope === 'sentence' ? after.search(profile.sentenceEnd) : -1;
        const scope = after.slice(0, sentenceEnd < 0 ? scopeCap : Math.min(sentenceEnd, scopeCap));
        masculine += (scope.match(new RegExp(profile.gender.masculine.source, profile.gender.masculine.flags)) || []).length;
        feminine += (scope.match(new RegExp(profile.gender.feminine.source, profile.gender.feminine.flags)) || []).length;
    }

    let gender = null;
    if (masculine + feminine >= 3) {
        if (masculine > feminine * 1.5) gender = 'm';
        else if (feminine > masculine * 1.5) gender = 'f';
    }
    return { gender, masculine, feminine, supported: true };
}

/**
 * Candidate characters for the point-of-view cast, with the evidence a model
 * would otherwise have to count for itself.
 *
 * Ranking by raw frequency is a trap here: in second-person narration the focal
 * character is named least of all — measured 31 mentions for Sue against 201 for
 * Jack, who is merely seen from the outside a lot. So `speechShare` (how much of
 * a name's occurrences are inside quoted speech) is reported too: people address
 * the narrator out loud even when the narration never names them.
 *
 * @param {string} text
 * @param {Array<{original: string, type?: string, gender?: string, notes?: string}>} glossary
 * @param {number} limit
 */
// Vocatives that are not names: ranks and forms of address ("…, Sergeant?"),
// plus the interjections that survive the pattern below.
const NOT_A_NAME = new Set([
    'sir', 'madam', 'maam', 'sergeant', 'inspector', 'constable', 'officer', 'captain',
    'doctor', 'doc', 'professor', 'detective', 'sarge', 'boss', 'chief', 'lieutenant',
    'mum', 'mom', 'dad', 'father', 'mother', 'son', 'lad', 'lass', 'mate', 'man', 'guys',
    'yes', 'yeah', 'sure', 'okay', 'right', 'well', 'please', 'thanks', 'sorry', 'hello',
    'god', 'christ', 'jesus', 'love', 'dear', 'darling', 'honey',
]);

/**
 * Names in vocative position inside dialogue: "…, Sue?" or "Sue, get over here".
 *
 * The glossary cannot be the only source of candidates. It is built chunk by
 * chunk, so it holds whatever surface form Stage 1 happened to see — in one
 * measured case "Sue Smith", which occurs exactly once in the book, while the
 * form people actually use, "Sue", was missing entirely. Someone addressed out
 * loud is a character worth considering whether or not the glossary noticed.
 */
function vocativeCandidates(speech, profile) {
    // Only for scripts that mark address the way the pattern assumes. Chinese,
    // Japanese and Korean mark it with honorific suffixes and prefixes (哥, 姐,
    // 君, さん, 아/야) instead, which is a different job than a regex on case.
    if (!profile.supports.vocative || !profile.vocative) return [];

    const names = new Map();
    const add = (raw) => {
        const name = raw.trim();
        if (name.length < 3 || NOT_A_NAME.has(name.toLowerCase())) return;
        names.set(name.toLowerCase(), name);
    };
    // "…, Sue?" — a capitalised word between a comma and end of phrase. The
    // mirror pattern ("Sue, …" opening a quote) was tried and dropped: every
    // interjection matches it — "Yeah, …", "Sure, …", "Well, …" — and the noise
    // pushed real characters out of the list.
    for (const m of speech.matchAll(new RegExp(profile.vocative.source, profile.vocative.flags))) add(m[1]);
    return [...names.values()];
}

export function characterCandidates(text, glossary, limit = 25) {
    const profile = profileForText(text);
    const speech = (text.match(quotedSpeechRegex(profile)) || []).join(' ');
    // Two-character names are ordinary in Chinese, Japanese and Korean; the
    // three-character floor is a Latin-script assumption.
    const minNameLength = profile.spaced && profile.supports.vocative ? 3 : 2;

    const byName = new Map();
    for (const name of vocativeCandidates(speech, profile)) {
        byName.set(name.toLowerCase(), { name, notes: '' });
    }
    for (const term of glossary || []) {
        const name = String(term.original || '').trim();
        if (term.type !== 'name') continue;
        if (!new RegExp(`^\\p{L}[\\p{L}'’-]{${minNameLength - 1},}$`, 'u').test(name)) continue;
        const key = name.toLowerCase();
        // Stage 1 can store the same name in several cases ("ELAINE" from a
        // chapter heading and "Elaine" from prose) — keep one entry.
        if (!byName.has(key)) {
            byName.set(key, {
                name: name.length > 1 && name === name.toUpperCase()
                    ? name.charAt(0) + name.slice(1).toLowerCase()
                    : name,
                notes: term.notes || '',
            });
        }
    }

    const scored = [...byName.values()]
        .map(entry => {
            const total = countOccurrences(text, entry.name);
            const inSpeech = countOccurrences(speech, entry.name);
            const { gender, masculine, feminine } = genderFromPronouns(text, entry.name);
            return {
                ...entry,
                count: total,
                speechShare: total ? inSpeech / total : 0,
                gender,
                pronouns: { masculine, feminine },
            };
        })
        .filter(entry => entry.count >= 3);

    // Two signals, and they find different people. Being addressed out loud
    // marks a narrator, whose name the narration itself avoids; being mentioned
    // often marks someone everyone else talks about. Ranking by either alone
    // drops half the cast — measured: by speech share the second-person narrator
    // Sue ranks 9th but Elaine, named 146 times by the other narrators, falls
    // off the list entirely. So take the head of both and merge.
    // Speech share is weighted by frequency, otherwise a name mentioned three
    // times, all in dialogue, outranks the protagonist.
    const half = Math.max(1, Math.ceil(limit / 2));
    const bySpeech = [...scored]
        .sort((a, b) => b.speechShare * Math.log1p(b.count) - a.speechShare * Math.log1p(a.count))
        .slice(0, half);
    const byFrequency = [...scored].sort((a, b) => b.count - a.count).slice(0, half);

    const merged = new Map();
    for (const entry of [...bySpeech, ...byFrequency]) merged.set(entry.name.toLowerCase(), entry);
    return [...merged.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}
