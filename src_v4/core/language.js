import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// Word-boundary matching that works outside ASCII. JavaScript's \b is defined
// over [A-Za-z0-9_], so /\bя\b/ never matches Cyrillic and /\bлюбой\b/ never
// fires — the Russian tables below silently counted zero pronouns until this
// replaced them. Pronoun sets are therefore written as word lists and compiled
// here, so the boundary bug cannot be reintroduced one regex at a time.
const WORD_EDGE = '[\\p{L}\\p{N}]';
function words(list) {
    const alternatives = list.split(/\s+/).filter(Boolean)
        .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .sort((a, b) => b.length - a.length);       // longest first: «они» before «он»
    return new RegExp(`(?<!${WORD_EDGE})(?:${alternatives.join('|')})(?!${WORD_EDGE})`, 'giu');
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
            first: words('i me my mine myself'),
            second: words('you your yours yourself'),
            third: words('he she him her his hers himself herself'),
        },
        gender: { masculine: words('he him his'), feminine: words('she her hers') },
    },

    cyrillic: {
        ...EUROPEAN,
        id: 'cyrillic',
        person: {
            first: words('я меня мне мной мой моя моё мои'),
            second: words('ты тебя тебе тобой твой твоя твоё вы вас вам вами ваш ваша'),
            third: words('он она его её ему ей им им нём ней'),
        },
        gender: { masculine: words('он его ему им нём'), feminine: words('она её ей ею ней') },
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

/**
 * Function words, ~14 per language, for identifying which language a text is in.
 *
 * Script is not enough. Polish, German and English are all Latin, so keying the
 * tables by script hands Polish the English pronouns — and the English
 * first-person pattern \b(i|me|my|...)\b then matches the Polish conjunction
 * "i" ("and"). Measured on a Polish novel: 136 "first person" hits, 123 of them
 * the word "and", and the pipeline reported "first person, 100%" for a text
 * written in the third. That is the failure this exists to prevent: a confident
 * wrong number is worse than an admitted blank.
 *
 * Measured on the corpus at hand (English, Polish and Russian books): 5 of 5
 * identified, the runner-up trailing by 12–20 percentage points.
 */

const FUNCTION_WORDS = {
    en: 'the of and to in that is was it for he his with as on but',
    ru: 'и в не на что он с как это по её его она они был',
    pl: 'i w nie na że się do jest z o jak tego ale był',
    uk: 'і в не на що він з як це по але його вона було',
    de: 'der die und den das ist nicht mit von zu sich auf dem ein',
    fr: 'les des est que dans pour qui une pas sur avec par il',
    es: 'que los del las por con una para más como pero sus',
    it: 'che non per una con del sono come nel alla dei suo',
    pt: 'que não uma dos com para como mais pelo seu era',
    tr: 'bir bu ile için daha çok olarak ama gibi kadar sonra',
};

const FUNCTION_WORD_SETS = Object.fromEntries(
    Object.entries(FUNCTION_WORDS).map(([lang, words]) => [lang, new Set(words.split(/\s+/))])
);

/**
 * Which language a text is written in, by function-word frequency.
 *
 * @returns {{lang: string|null, share: number, margin: number}}
 *   `margin` is how far the winner leads the runner-up, as a share of all words.
 *   A thin margin means the guess is not to be trusted — the caller drops to the
 *   script profile, or to no profile at all.
 */
export function detectLanguage(text) {
    const words = String(text || '').toLowerCase().match(/[\p{L}]+/gu);
    if (!words || words.length < 50) return { lang: null, share: 0, margin: 0 };

    const sets = functionWordSets();
    const sample = words.slice(0, 20000);
    const scores = Object.fromEntries(Object.keys(sets).map(l => [l, 0]));
    for (const word of sample) {
        for (const [lang, set] of Object.entries(sets)) {
            if (set.has(word)) scores[lang]++;
        }
    }

    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const share = ranked[0][1] / sample.length;
    const margin = (ranked[0][1] - ranked[1][1]) / sample.length;

    // The absolute share is what separates a real match from a near miss, not
    // the margin. Measured: texts in a language this table knows spend 14–21% of
    // their words on its function words, while Dutch — which has none of its own
    // here — matched English on 6.8% and led by that same 6.8% simply because
    // nothing else matched at all. A high margin over an empty field means
    // nothing; the floor is what rejects a language we do not actually know.
    if (share < 0.10 || margin < 0.03) return { lang: null, share, margin };
    return { lang: ranked[0][0], share, margin };
}

// Languages that share a script but not their grammar. Only what actually
// differs from the script profile is listed; the rest is inherited.
const LANGUAGE_PROFILES = {
    en: {},   // the Latin profile was written for English
    ru: {},   // likewise the Cyrillic one
    pl: {
        person: {
            first: words('ja mnie mi mną mój moja moje moim my nas nam nami'),
            second: words('ty ciebie cię ci tobą twój twoja twoje wy was wam wami'),
            third: words('on ona ono jego jej go mu jemu nim nią oni one ich im nimi'),
        },
        gender: {
            masculine: words('on jego go mu jemu nim'),
            feminine: words('ona jej ją nią niej'),
        },
        // Polish marks address with the vocative case (Everett → Everetcie),
        // not with the comma-plus-capital shape the Latin profile looks for.
        vocative: null,
        supports: { narrativePerson: true, gender: true, vocative: false },
    },
    uk: {
        person: {
            first: words('я мене мені мною мій моя моє ми нас нам нами'),
            second: words('ти тебе тобі тобою твій твоя ви вас вам вами'),
            third: words('він вона воно його її йому їй ним нею вони їх їм'),
        },
        gender: { masculine: words('він його йому ним'), feminine: words('вона її їй нею') },
        vocative: null,
        supports: { narrativePerson: true, gender: true, vocative: false },
    },
    de: {
        person: {
            first: words('ich mich mir mein meine meinen wir uns unser'),
            second: words('du dich dir dein deine ihr euch euer sie ihnen'),
            third: words('er ihn ihm sein seine sie ihr ihre es'),
        },
        gender: { masculine: words('er ihn ihm sein seine seinen'), feminine: words('sie ihr ihre ihren') },
        quotePairs: [['„', '“'], ['»', '«'], ['“', '”'], ['"', '"']],
    },
    fr: {
        person: {
            first: words("je j' me moi mon ma mes nous notre nos"),
            second: words('tu te toi ton ta tes vous votre vos'),
            third: words('il elle lui le la son sa ses ils elles leur'),
        },
        gender: { masculine: words('il lui son'), feminine: words('elle sa') },
        quotePairs: [['«', '»'], ['“', '”'], ['"', '"']],
    },
    es: {
        person: {
            first: words('yo me mí mi mis nosotros nos nuestro nuestra'),
            second: words('tú te ti tu tus usted ustedes vosotros os vuestro'),
            third: words('él ella le lo la su sus ellos ellas les'),
        },
        gender: { masculine: words('él lo suyo'), feminine: words('ella la suya') },
        quotePairs: [['«', '»'], ['“', '”'], ['"', '"']],
    },
    it: {
        person: {
            first: words('io me mi mio mia miei noi ci nostro nostra'),
            second: words('tu te ti tuo tua tuoi voi vi vostro vostra'),
            third: words('lui lei lo la gli le suo sua loro essi'),
        },
        gender: { masculine: words('lui suo egli'), feminine: words('lei sua ella') },
        quotePairs: [['«', '»'], ['“', '”'], ['"', '"']],
    },
    pt: {
        person: {
            first: words('eu me mim meu minha meus nós nos nosso nossa'),
            second: words('tu te ti teu tua você vocês vos vosso'),
            third: words('ele ela lhe o a seu sua eles elas lhes'),
        },
        gender: { masculine: words('ele dele seu'), feminine: words('ela dela sua') },
        quotePairs: [['«', '»'], ['“', '”'], ['"', '"']],
    },
    // Turkish marks person with suffixes rather than free pronouns, so counting
    // pronouns understates it badly. Left unsupported rather than guessed at.
    tr: { person: null, gender: null, supports: { narrativePerson: false, gender: false, vocative: false } },
};

// Profiles learned from a model and validated against real text, loaded from
// the shared file. They are data of exactly the same standing as the built-in
// tables — the only difference is who wrote them first.
let learnedProfiles = null;

function learned() {
    if (learnedProfiles) return learnedProfiles;
    learnedProfiles = {};
    try {
        const file = path.join(__dirname, '..', 'language_profiles.json');
        if (fs.existsSync(file)) learnedProfiles = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch { /* a broken profiles file must not take down a translation run */ }
    return learnedProfiles;
}

/** Forget the cache — used after learning a new language mid-run. */
export function reloadLearnedProfiles() {
    learnedProfiles = null;
}

/** Turn a stored profile (word lists and characters) into a compiled one. */
function compileLearned(entry) {
    const compiled = {};
    if (entry.pronouns) {
        compiled.person = {
            first: words(entry.pronouns.first || ''),
            second: words(entry.pronouns.second || ''),
            third: words(entry.pronouns.third || ''),
        };
    }
    const masc = String(entry.gender?.masculine || '').trim();
    const fem = String(entry.gender?.feminine || '').trim();
    compiled.gender = (masc && fem) ? { masculine: words(masc), feminine: words(fem) } : null;

    if (entry.sentenceEnd) {
        const cls = [...entry.sentenceEnd].map(c => c.replace(/[\\\]^-]/g, '\\$&')).join('');
        compiled.sentenceEnd = new RegExp(`[${cls}\\n]`, 'u');
    }
    if (Array.isArray(entry.quotePairs) && entry.quotePairs.length) {
        compiled.quotePairs = entry.quotePairs.filter(p => Array.isArray(p) && p.length === 2);
    }
    // The vocative pattern is the code's own; the model only says whether the
    // language marks address that way at all.
    if (entry.vocativeByComma === false) compiled.vocative = null;

    compiled.supports = {
        narrativePerson: !!compiled.person,
        gender: !!compiled.gender,
        vocative: entry.vocativeByComma !== false,
    };
    compiled.marksGenderOnVerbs = entry.marksGenderOnVerbs !== false;
    return compiled;
}

export function profileForScript(script) {
    return PROFILES[script] || UNSUPPORTED;
}

/** Function words of every language known, built-in and learned alike. */
function functionWordSets() {
    const sets = { ...FUNCTION_WORD_SETS };
    for (const [lang, entry] of Object.entries(learned())) {
        if (entry?.functionWords) sets[lang] = new Set(String(entry.functionWords).toLowerCase().split(/\s+/).filter(Boolean));
    }
    return sets;
}

/**
 * Profile inferred from the text: language first, script as the fallback.
 *
 * A language profile only overrides what it declares, so a Latin-script language
 * with no entry of its own still gets Latin quote marks and sentence ends — but
 * an unidentified language gets no pronoun tables at all rather than English
 * ones.
 */
export function profileForText(text) {
    const { script, share } = detectScript(text);
    const { lang, margin } = detectLanguage(text);
    const base = profileForScript(script);

    if (!lang) {
        // Unknown language on a spaced, cased script: the script tables are
        // English or Russian guesses, so refuse rather than mislead. Unspaced
        // scripts (Han, kana, Hangul) map to one language closely enough that
        // the script profile stands.
        const risky = base.id === 'latin' || base.id === 'cyrillic';
        const profile = risky
            ? { ...base, person: null, gender: null, supports: { ...base.supports, narrativePerson: false, gender: false } }
            : base;
        return { ...profile, script, scriptShare: share, lang: null, langMargin: margin };
    }

    const learnedEntry = learned()[lang];
    const override = LANGUAGE_PROFILES[lang] || (learnedEntry ? compileLearned(learnedEntry) : {});
    return {
        ...base,
        ...override,
        supports: { ...base.supports, ...(override.supports || {}) },
        id: lang,
        script,
        scriptShare: share,
        lang,
        langMargin: margin,
    };
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
