/**
 * Everything in the deterministic layer that depends on the source language.
 *
 * The layer measures things — narrative person, a character's gender, who is
 * addressed out loud — by looking for pronouns, sentence ends and quotation
 * marks. Every one of those is script-specific, and a rule written for English
 * does not fail loudly on Japanese: it silently finds nothing and returns an
 * answer shaped exactly like a real one. Measured on a Chinese passage before
 * this existed: the glossary matcher found 1 of 5 occurrences of 魏婴 and 0 of 2
 * of 江厌离, and nothing anywhere said the source was unsupported.
 *
 * So two rules hold here:
 *   - a profile keyed by script, not by language, because script is what can be
 *     detected reliably from the text alone;
 *   - and every capability is declared, so a caller can say "not determined for
 *     this script" instead of passing off an empty count as a measurement.
 *
 * Adding a language should be an entry in this table, never a change in logic.
 */

const SCRIPT_TESTS = [
    ['hangul', /\p{Script=Hangul}/u],
    ['kana', /[\p{Script=Hiragana}\p{Script=Katakana}]/u],
    ['han', /\p{Script=Han}/u],
    ['cyrillic', /\p{Script=Cyrillic}/u],
    ['thai', /\p{Script=Thai}/u],
    ['latin', /\p{Script=Latin}/u],
];

/**
 * Dominant script of a text, by character counts over a sample.
 *
 * Order matters for Japanese: it mixes kana with Han, and any kana at all means
 * Japanese rather than Chinese, so kana is checked before Han and wins on a much
 * lower share.
 */
export function detectScript(text) {
    const sample = String(text || '').slice(0, 200000);
    const counts = {};
    for (const [id, re] of SCRIPT_TESTS) {
        const global = new RegExp(re.source, 'gu');
        counts[id] = (sample.match(global) || []).length;
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (!total) return { script: 'unknown', counts, share: 0 };

    // Japanese: kana is sparse next to Han but decisive.
    if (counts.kana / total > 0.05) return { script: 'kana', counts, share: counts.kana / total };
    if (counts.hangul / total > 0.15) return { script: 'hangul', counts, share: counts.hangul / total };

    const [script, best] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return { script, counts, share: best / total };
}

// Latin- and Cyrillic-script prose: spaced, cased, pronoun-heavy.
const EUROPEAN = {
    spaced: true,
    sentenceEnd: /[.!?\n]/,
    quotePairs: [['“', '”'], ['"', '"'], ['«', '»'], ['„', '“']],
    // A capitalised word between a comma and the end of a phrase: "…, Sue?"
    vocative: /,\s*(\p{Lu}[\p{Ll}'’-]{2,})\s*[?!.,”"»]/gu,
    // Stop counting at the sentence end: European prose keeps a pronoun in the
    // same sentence as the name, and reaching further picks up the next
    // person mentioned.
    genderScope: 'sentence',
    supports: { narrativePerson: true, gender: true, vocative: true },
};

const PROFILES = {
    latin: {
        ...EUROPEAN,
        id: 'latin',
        person: {
            first: /\b(i|me|my|mine|myself)\b/g,
            second: /\b(you|your|yours|yourself)\b/g,
            third: /\b(he|she|him|her|his|hers|himself|herself)\b/g,
        },
        gender: { masculine: /\b(he|him|his)\b/gi, feminine: /\b(she|her|hers)\b/gi },
    },

    cyrillic: {
        ...EUROPEAN,
        id: 'cyrillic',
        person: {
            first: /\b(я|меня|мне|мной|мой|моя|моё|мои)\b/giu,
            second: /\b(ты|тебя|тебе|тобой|твой|твоя|твоё|вы|вас|вам|вами|ваш|ваша)\b/giu,
            third: /\b(он|она|его|её|ему|ей|им|им|нём|ней)\b/giu,
        },
        gender: { masculine: /\b(он|его|ему|им|нём)\b/giu, feminine: /\b(она|её|ей|ею|ней)\b/giu },
    },

    // Chinese. Written Chinese has distinguished 他/她 since the 1920s, so gender
    // works as well as it does in English. There is no case and no spacing, so
    // the vocative pattern cannot apply: address is marked by suffixes (哥, 姐,
    // 君) and prefixes (阿, 小, 老), which is a different job from a regex.
    han: {
        id: 'han',
        spaced: false,
        sentenceEnd: /[。！？…\n]/u,
        quotePairs: [['“', '”'], ['「', '」'], ['『', '』']],
        vocative: null,
        person: {
            first: /(我们|我)/gu,
            second: /(你们|您|你)/gu,
            third: /(他们|她们|他|她|它)/gu,
        },
        // 他们 / 她们 are "they" and say nothing about one person's gender.
        gender: { masculine: /他(?!们)/gu, feminine: /她(?!们)/gu },
        // Chinese runs topic chains: the name opens one sentence and the pronoun
        // referring to it lands in the next. Cutting at the sentence end finds
        // nothing at all — measured 0 masculine and 0 feminine for a character
        // followed by 他 twelve characters later.
        genderScope: 'window',
        supports: { narrativePerson: true, gender: true, vocative: false },
    },

    // Japanese. Pronouns are routinely omitted — a whole page can pass without
    // one — and 彼/彼女 are rare in narration. The counts stay honest, and the
    // minimum-evidence thresholds downstream turn thin data into an abstention
    // rather than a guess.
    kana: {
        id: 'kana',
        spaced: false,
        sentenceEnd: /[。！？…\n]/u,
        quotePairs: [['「', '」'], ['『', '』'], ['“', '”']],
        vocative: null,
        person: {
            first: /(私たち|僕たち|俺たち|私|わたし|僕|ぼく|俺|おれ)/gu,
            second: /(あなた|あんた|君|きみ|お前|おまえ)/gu,
            third: /(彼女たち|彼ら|彼女|彼)/gu,
        },
        gender: { masculine: /彼(?!女|ら)/gu, feminine: /彼女/gu },
        genderScope: 'window',
        supports: { narrativePerson: true, gender: true, vocative: false },
    },

    hangul: {
        id: 'hangul',
        spaced: true,          // Korean is spaced, but not cased
        sentenceEnd: /[.!?…\n]/u,
        quotePairs: [['“', '”'], ['「', '」'], ['‘', '’']],
        vocative: null,
        person: {
            first: /(우리|나는|나를|내가|저는|제가)/gu,
            second: /(너희|당신|너는|너를|네가)/gu,
            third: /(그들|그녀|그는|그를)/gu,
        },
        gender: { masculine: /그(?!녀|들)/gu, feminine: /그녀/gu },
        genderScope: 'window',
        supports: { narrativePerson: true, gender: true, vocative: false },
    },
};

// Used when the script is unknown or has no profile. Everything is declared
// unsupported, so callers report "not determined" instead of inventing a zero.
const UNSUPPORTED = {
    id: 'unsupported',
    spaced: true,
    sentenceEnd: /[.!?\n]/,
    quotePairs: [['“', '”'], ['"', '"']],
    vocative: null,
    person: null,
    gender: null,
    genderScope: 'sentence',
    supports: { narrativePerson: false, gender: false, vocative: false },
};

export function profileForScript(script) {
    return PROFILES[script] || UNSUPPORTED;
}

/** Profile inferred from the text itself. */
export function profileForText(text) {
    const { script, share } = detectScript(text);
    return { ...profileForScript(script), script, scriptShare: share };
}

/** Regex matching quoted speech for a profile, across all its quote styles. */
export function quotedSpeechRegex(profile) {
    const alternatives = (profile.quotePairs || []).map(([open, close]) => {
        const o = open.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const c = close.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Straight quotes open and close with the same character, so the body
        // must not contain it; paired marks may not contain their own closer.
        return o === c ? `${o}[^${c}]{0,600}${c}` : `${o}[^${c}]{0,600}${c}`;
    });
    return new RegExp(alternatives.join('|'), 'gu');
}

/**
 * Chapter headings that carry no case distinction and so cannot be caught by the
 * heuristics written for European prose: 第一章, 第12話, 제3장.
 */
export const CJK_HEADING = /^\s*(?:第\s*[0-9０-９一二三四五六七八九十百千]+\s*[章回節话話幕部]|제\s*[0-9０-９일이삼사오육칠팔구십백]+\s*[장화부]).{0,40}$/u;
