/**
 * The book passport — decisions that hold for the whole book and must not be
 * re-invented on every chunk.
 *
 * Measured on an existing project (Halting State, translated chunk by chunk):
 * the second-person narration flipped between "ты" and "вы" in 19–41% of
 * narrative sentences depending on the point-of-view character, and gender
 * agreement after "ты" came out 35 masculine / 36 feminine for a female
 * narrator — a coin flip. Nothing in the pipeline pinned those choices, so the
 * model decided afresh each time. More context does not fix a coin flip;
 * a decision recorded once and injected as a constraint does.
 *
 * Stored next to the glossary as <prefix>_passport.json, for the same reasons:
 * a human edits it, and a Stage 2 reset must not destroy it.
 */

import fs from 'fs';
import { wholeWordRegex } from './text_stats.js';
import { countTokens } from './tokenizer.js';
import config from '../config.js';

export const PASSPORT_VERSION = 1;

// One budget for every dossier. The focal narrator used to get 500 characters
// and each other cast member in the scene 300, which cut all of them: measured,
// real dossiers run 414–763 characters, so the secondary limit truncated every
// single one and the primary one truncated the longest.
const DOSSIER_TOKENS = config.pipeline.dossierMaxTokens || 600;

/**
 * @typedef {Object} Passport
 * @property {number} version
 * @property {string} updatedAt
 * @property {{model: string|null, generatedAt: string|null}} source
 *   Which model produced the generated parts, and when. Hand edits leave this
 *   alone, so it always answers "where did this come from".
 * @property {'fiction'|'nonfiction'|null} kind
 *   What kind of book this is. It decides who "you" refers to in second-person
 *   narration — the focal character (fiction) or the reader (a guide, a manual,
 *   an essay) — which are opposite referents dressed in the same pronoun. It
 *   also picks the register instruction: a how-to guide translated "literarily,
 *   preserving the author's style" is as wrong as a novel translated for
 *   terminological precision.
 * @property {string|null} register
 *   Free-form, from the model: "разговорный", "академический", … Substituted
 *   into the prompt as a value, so it stays a phrase, not a sentence.
 * @property {'m'|'f'|'neutral'|null} readerGender
 *   Gender to use when the narration addresses the reader and the reader is not
 *   a character (nonfiction second person). Measured on the owner's proofread
 *   guide: 9 masculine forms after "ты", 0 feminine — Russian defaults to
 *   masculine for an unknown addressee. A value rather than a hard-coded rule:
 *   some editors prefer neutral phrasing, and that is an editorial choice.
 * @property {{person: 'first'|'second'|'third'|null,
 *             tense: 'present'|'past'|null,
 *             addressForm: string|null,
 *             addressNote: string|null}} narration
 *   addressForm is the bare pronoun the narration addresses the reader with in
 *   second person («ты»/«вы»/"du"/…) — it is substituted into prompts, so it
 *   must stay a value, not a sentence; explanations live in addressNote.
 *   Preserving the original's present tense matters beyond faithfulness: in
 *   Russian the present tense carries no gender, so it sidesteps most agreement
 *   errors on its own.
 * @property {Array<{name: string, gender: 'm'|'f'|'n'|null, dossier: string}>} characters
 *   The point-of-view cast. `dossier` is what a reader accumulates by chapter
 *   three — role, rank, workplace, relations — and it is exactly what a model
 *   asked to identify a narrator cold does not have.
 * @property {Array<{fromChunk: number, toChunk: number, character: string|null,
 *                   source: 'anchor'|'inferred'|'manual'}>} povMap
 *   Inclusive chunk ranges. `character: null` means undetermined — a working
 *   mode, not a failure: the prompt is then told to avoid gendered forms rather
 *   than guess, which yields flatter but consistent text.
 * @property {Array<{from: string, to: string, form: string}>} addressRegistry
 *   Which characters are on "ты" with which. A property of the pair, invisible
 *   inside a single chunk.
 * @property {Array<{character: string, strategy: string,
 *                   samples: Array<{original: string, translation: string}>}>} voices
 *   Marked speech (dialect, register, verbal tics). The approved samples matter
 *   more than the description: they go into the prompt as few-shot examples.
 * @property {{name: string|null, gender: 'm'|'f'|'n'|null, note: string|null}|null} author
 *   Who wrote the book, and their grammatical gender. Needed wherever the author
 *   speaks in their own first person — preface, afterword, acknowledgements,
 *   notes — because there "I" is the author, not the narrator, and nothing
 *   inside a chunk says so. Measured on Morphotrophic: the afterword reads «я
 *   должна пояснить» and «я обязана трудам Левина», and Greg Egan is a man. The
 *   chunk had no way to know; the passport does.
 *
 *   Deliberately not a member of `characters`, which is the point-of-view cast:
 *   in a novel the author is not in the story at all. Non-fiction used to file
 *   them as cast[0], which still works and is still read when this field is
 *   empty.
 * @property {{marker: string, sample: string|null, source: 'model'|'hand'}|null} dialogue
 *   How direct speech is set in the TARGET LANGUAGE — the punctuation a line of
 *   dialogue opens with, plus an example. A norm, settled before translation
 *   starts, not an observation about any text: the original's convention is the
 *   one thing that must not be carried across, and the translation's own
 *   majority would make a badly translated book the authority on how it should
 *   have been translated. On Morphotrophic, where nobody settled it, 1464 lines
 *   open with — and 303 with «, because the 27 chunks that chose quotation marks
 *   had no way of knowing what the other 142 had done.
 */

/** A passport with nothing decided yet. */
export function emptyPassport() {
    return {
        version: PASSPORT_VERSION,
        updatedAt: new Date().toISOString(),
        source: { model: null, generatedAt: null },
        kind: null,
        register: null,
        readerGender: 'm',
        narration: { person: null, tense: null, addressForm: null, addressNote: null },
        author: null,
        characters: [],
        povMap: [],
        addressRegistry: [],
        voices: [],
        dialogue: null,
    };
}

/**
 * Read the passport, filling in anything the file omits. Never throws on a
 * malformed file: a broken passport must not take down a translation run that
 * would otherwise work without one.
 */
export function loadPassport(passportPath) {
    if (!fs.existsSync(passportPath)) return emptyPassport();
    try {
        const raw = JSON.parse(fs.readFileSync(passportPath, 'utf-8'));
        const base = emptyPassport();
        return {
            ...base,
            ...raw,
            // Passports written before these fields existed read as fiction with
            // the default reader gender — which is what they were.
            kind: raw.kind ?? base.kind,
            register: raw.register ?? base.register,
            readerGender: raw.readerGender ?? base.readerGender,
            source: { ...base.source, ...(raw.source || {}) },
            narration: { ...base.narration, ...(raw.narration || {}) },
            // Only worth carrying when it says something. A name without a
            // gender answers no question the style block asks.
            author: raw.author && typeof raw.author === 'object' && (raw.author.name || raw.author.gender)
                ? { name: raw.author.name || null, gender: raw.author.gender || null, note: raw.author.note || null }
                : base.author,
            characters: Array.isArray(raw.characters) ? raw.characters : [],
            povMap: Array.isArray(raw.povMap) ? raw.povMap : [],
            addressRegistry: Array.isArray(raw.addressRegistry) ? raw.addressRegistry : [],
            voices: Array.isArray(raw.voices) ? raw.voices : [],
            // Only a real marker counts. An entry without one would put an empty
            // instruction into every prompt, which is worse than no instruction.
            dialogue: raw.dialogue && typeof raw.dialogue === 'object' && raw.dialogue.marker
                ? raw.dialogue : base.dialogue,
        };
    } catch (e) {
        console.warn(`[Passport] Failed to read ${passportPath}: ${e.message}. Continuing without it.`);
        return emptyPassport();
    }
}

/** Write the passport atomically, the way project state is written. */
export function savePassport(passportPath, passport) {
    const data = { ...passport, version: PASSPORT_VERSION, updatedAt: new Date().toISOString() };
    const tempFile = `${passportPath}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
    fs.renameSync(tempFile, passportPath);
    return data;
}

/**
 * Has a person edited this passport since the model produced it?
 *
 * `generatedAt` is stamped only by the stage that builds it, while `updatedAt`
 * is rewritten on every save — including the editor's. So a gap between them is
 * a human. Measured on seven real passports, none of them hand-edited: the gap
 * is exactly zero milliseconds, both stamps being taken during the same save.
 * The tolerance is for a save slow enough to cross a millisecond boundary, not
 * for judgement.
 */
export function handEdited(passport) {
    const generated = Date.parse(passport?.source?.generatedAt || '');
    const updated = Date.parse(passport?.updatedAt || '');
    if (!Number.isFinite(generated) || !Number.isFinite(updated)) return false;
    return updated - generated > 5000;
}

/** The point-of-view character of a chunk, or null when undetermined. */
export function povForChunk(passport, chunkIndex) {
    for (const span of passport.povMap || []) {
        if (chunkIndex >= span.fromChunk && chunkIndex <= span.toChunk) {
            return span.character ?? null;
        }
    }
    return null;
}

/** Look up a character's dossier entry by name, case-insensitively. */
export function findCharacter(passport, name) {
    if (!name) return null;
    const key = String(name).toLowerCase();
    return (passport.characters || []).find(c => String(c.name).toLowerCase() === key) || null;
}

// Token counts of dossiers already measured. The text does not change during a
// run while the style block is rebuilt for every chunk and every retry, and the
// tokenizer costs 12 ms a call — enough to notice across a book.
const tokenCounts = new Map();

/**
 * Trim a dossier to a token budget, ending on a word.
 *
 * Counted in tokens rather than characters because that is what the budget is
 * actually spent in, and the ratio is not a constant: measured on real
 * dossiers, Russian runs 3.16–3.35 characters per token, and a Latin-script
 * target language would run differently again.
 *
 * The tokenizer is skipped whenever the answer is already certain — a token is
 * never shorter than one character, so anything under the limit in characters
 * is under it in tokens too. That covers every dossier written so far.
 */
function fitToTokens(text, limit) {
    const s = String(text || '');
    if (s.length <= limit) return s;

    let tokens = tokenCounts.get(s);
    if (tokens === undefined) { tokens = countTokens(s); tokenCounts.set(s, tokens); }
    if (tokens <= limit) return s;

    // The ratio holds within one dossier, so scaling the length by it lands
    // close enough; the cut is then pulled back to the last word boundary.
    const keep = Math.floor(s.length * limit / tokens);
    const cut = s.slice(0, keep);
    const space = cut.lastIndexOf(' ');
    return (space > keep * 0.8 ? cut.slice(0, space) : cut).trimEnd() + '…';
}

// Wording tables for the <style> block, keyed by prompt language.
const STYLE_WORDS = {
    ru: {
        person: { first: 'от 1-го лица', second: 'от 2-го лица', third: 'от 3-го лица' },
        // Одно и то же «ты» указывает на разных людей: в художественном тексте —
        // на персонажа, чьими глазами смотрит читатель; в руководстве или эссе —
        // на самого читателя, которого автор не знает.
        secondPerson: {
            fiction: '«Ты» — это персонаж, чьими глазами читатель видит происходящее.',
            nonfiction: '«Ты» — это ЧИТАТЕЛЬ, к которому обращается автор, а не персонаж книги.',
        },
        readerGender: {
            m: 'Пол читателя неизвестен: родовые формы при обращении к нему — мужского рода (норма русского языка для неизвестного адресата).',
            f: 'Родовые формы при обращении к читателю — женского рода.',
            neutral: 'Пол читателя неизвестен: избегай родовых форм при обращении к нему, перестраивай фразы.',
        },
        register: (value) => `Регистр перевода: ${value}. Держи его на всём протяжении.`,
        genderShort: { m: 'мужчина', f: 'женщина' },
        precision: 'Это НЕхудожественный текст. Переводи ТОЧНО: сохраняй терминологию, факты, числа и структуру. Не украшай, не добавляй образности, которой нет в оригинале.',
        author: (name, genderTxt) => `Автор текста: ${name}, ${genderTxt}. Когда автор говорит о себе («я»), используй этот род.`,
        authorDossier: (text) => `Досье автора: ${text}`,
        // Fiction only, and deliberately fenced. In a novel «я» belongs to the
        // narrator on almost every page; the author owns it only in the matter
        // around the story. Said without the fence, this line would order the
        // author's gender onto a first-person narrator of the opposite one.
        authorVoice: (name, genderTxt) => `Автор книги — ${name}, ${genderTxt}. `
            + `Это правило действует ТОЛЬКО там, где от первого лица говорит сам автор: предисловие, `
            + `послесловие, благодарности, авторские примечания — там родовые формы при «я» берутся от автора. `
            + `В основном тексте «я» — это повествователь или персонаж, и род берётся от него.`,
        tense: { present: 'настоящее время', past: 'прошедшее время' },
        narration: (p, t) => `Повествование: ${[p, t ? `основное время — ${t}` : null].filter(Boolean).join(', ')}. ЭТАЛОН ВРЕМЕНИ — ОРИГИНАЛ, фраза за фразой: где автор пишет в прошедшем (воспоминания, события до момента повествования), прошедшее сохраняется — это НЕ нарушение.`,
        address: (form) => `Обращение к читателю в АВТОРСКОМ ПОВЕСТВОВАНИИ: ${form}. Не переключайся между «ты» и «вы» в повествовании. На обращения персонажей друг к другу (диалоги, письма, протоколы, чаты) это правило НЕ распространяется — там уместно и вежливое «вы».`,
        gender: { m: 'МУЖЧИНА — все родовые формы (глаголы прошедшего времени, прилагательные, причастия), относящиеся к повествователю, мужского рода', f: 'ЖЕНЩИНА — все родовые формы (глаголы прошедшего времени, прилагательные, причастия), относящиеся к повествователю, женского рода' },
        focal: (name, genderTxt) => `Повествователь этого фрагмента: ${name}, ${genderTxt}.`,
        dossier: (text) => `Досье повествователя: ${text}`,
        other: (name, text) => `Также в этом фрагменте: ${name}. Досье: ${text}`,
        dialogueAddress: 'В диалогах форму обращения («ты»/«вы») выбирай по отношениям персонажей из досье: подчинённые к начальству, свидетели к полиции, незнакомцы и деловые собеседники — обычно на «вы»; близкие, семья и приятели — на «ты».',
        // Says "the norm of the target language", not "this is how the book is
        // set": the marker is settled before anything is translated, so on the
        // first chunk the claim would be false — and the sample is invented for
        // the language, not quoted from the book.
        dialogueMarker: (marker, sample) => `Оформление прямой речи: реплика начинается с «${marker}» — это норма целевого языка. `
            + `Держи её одинаково во всей книге и НЕ переноси пунктуацию диалогов из оригинала.`
            + (sample ? `\nОбразец оформления: ${sample}` : ''),
        undetermined: 'Кто повествователь этого фрагмента — НЕ определено. НЕ приписывай повествователю род: держи время повествования и перестраивай фразы так, чтобы родовые формы не требовались.',
    },
    en: {
        person: { first: 'first person', second: 'second person', third: 'third person' },
        secondPerson: {
            fiction: '"You" is the character through whose eyes the reader sees events.',
            nonfiction: '"You" is the READER the author is addressing, not a character in the book.',
        },
        readerGender: {
            m: 'The reader\'s gender is unknown: use masculine forms when addressing them (the default for an unknown addressee).',
            f: 'Use feminine forms when addressing the reader.',
            neutral: 'The reader\'s gender is unknown: avoid gendered forms when addressing them, rephrase instead.',
        },
        register: (value) => `Register of the translation: ${value}. Hold it throughout.`,
        genderShort: { m: 'male', f: 'female' },
        precision: 'This is NON-FICTION. Translate PRECISELY: preserve terminology, facts, figures and structure. Do not embellish or add imagery the original does not have.',
        author: (name, genderTxt) => `The author: ${name}, ${genderTxt}. Use this gender when the author speaks of themselves ("I").`,
        authorDossier: (text) => `Author's dossier: ${text}`,
        authorVoice: (name, genderTxt) => `The author of this book is ${name}, ${genderTxt}. `
            + `This applies ONLY where the author speaks in their own first person: preface, afterword, `
            + `acknowledgements, author's notes — there the gendered forms around "I" are the author's. `
            + `In the body of the book "I" is the narrator or a character, and the gender is theirs.`,
        tense: { present: 'present tense', past: 'past tense' },
        narration: (p, t) => `Narration: ${[p, t ? `base tense — ${t}` : null].filter(Boolean).join(', ')}. THE TENSE AUTHORITY IS THE ORIGINAL, phrase by phrase: where the author writes in the past (memories, events before the narrative moment), the past is kept — that is NOT a violation.`,
        address: (form) => `Form of address to the reader in the AUTHOR'S NARRATION: ${form}. Never switch between formal and informal in the narration. This rule does NOT extend to characters addressing each other (dialogue, letters, transcripts, chats) — polite address is appropriate there.`,
        gender: { m: 'MALE — every gendered form (past-tense verbs, adjectives, participles) referring to the narrator must be masculine', f: 'FEMALE — every gendered form (past-tense verbs, adjectives, participles) referring to the narrator must be feminine' },
        focal: (name, genderTxt) => `The narrator of this fragment: ${name}, ${genderTxt}.`,
        dossier: (text) => `Narrator's dossier: ${text}`,
        other: (name, text) => `Also in this fragment: ${name}. Dossier: ${text}`,
        dialogueAddress: 'In dialogue, choose the form of address (formal/informal) from the characters\' relationships in the dossiers: subordinates to superiors, witnesses to police, strangers and business contacts are usually formal; family and close friends informal.',
        dialogueMarker: (marker, sample) => `Setting of direct speech: a line of dialogue opens with "${marker}" — the norm of the target language. `
            + `Keep it uniform through the whole book and do NOT carry the original's dialogue punctuation across.`
            + (sample ? `\nExample of the setting: ${sample}` : ''),
        undetermined: 'The narrator of this fragment is NOT determined. Do not assign the narrator a gender: keep the narrative tense and rephrase so gendered forms are not needed.',
    },
};

/**
 * The <style> block for one chunk's translation and review prompts — the
 * passport's decisions rendered as hard constraints.
 *
 * Returns '' when there is nothing to say, so projects without a passport get
 * byte-identical prompts to what they had before.
 *
 * The focal-character part only fires for first/second person narration: that
 * is where the narrator's gender is invisible inside a chunk (measured: a coin
 * flip, 35/36 for a female narrator). Undetermined POV is a working mode, not
 * an error — the instruction is to avoid gendered forms, which is consistent
 * and strictly better than guessing.
 */
export function buildStyleBlock(passport, chunkIndex, promptLang = 'ru', chunkText = '') {
    if (!passport || isEmptyPassport(passport)) return '';
    const words = STYLE_WORDS[promptLang] || STYLE_WORDS.ru;
    const lines = [];

    const { person, tense, addressForm } = passport.narration || {};
    const nonfiction = passport.kind === 'nonfiction';
    const personTxt = words.person[person] || null;
    const tenseTxt = words.tense[tense] || null;
    if (personTxt || tenseTxt) lines.push(words.narration(personTxt, tenseTxt));
    if (nonfiction) lines.push(words.precision);
    if (passport.register) lines.push(words.register(passport.register));
    // Before the address form and the cast, because it applies to every chunk
    // alike: how speech is set is the one decision that has no exceptions.
    if (passport.dialogue?.marker) {
        lines.push(words.dialogueMarker(passport.dialogue.marker, passport.dialogue.sample));
    }
    if (addressForm) lines.push(words.address(addressForm));
    // Second person hides two opposite referents behind one pronoun, so it is
    // spelled out rather than left to the model to infer.
    if (person === 'second') lines.push(words.secondPerson[nonfiction ? 'nonfiction' : 'fiction']);

    const cast = passport.characters || [];
    let focal = null;
    let dossiersShown = 0;

    // Non-fiction: "you" is the reader, whose gender is a project-level decision,
    // and the author's gender governs "I", not "you". The author lives in its own
    // field now; passports written before it exists filed them as cast[0], which
    // is still read so those projects keep working.
    const author = passport.author?.gender ? passport.author : cast[0];
    const authorGender = author?.gender === 'm' || author?.gender === 'f' ? author.gender : null;

    if (nonfiction) {
        if (person === 'second') {
            lines.push(words.readerGender[passport.readerGender || 'm'] || words.readerGender.m);
        }
        if (authorGender) {
            lines.push(words.author(author.name, words.genderShort[authorGender]));
            // The dossier belongs to the cast entry; the author field carries no
            // prose, so this only fires on the old shape.
            if (author.dossier) {
                lines.push(words.authorDossier(fitToTokens(author.dossier, DOSSIER_TOKENS)));
                dossiersShown++;
            }
        }
        return lines.join('\n');
    }

    // Fiction: the author is not in the story, and owns "I" only in the matter
    // around it. Said on every chunk because front and back matter can sit at
    // either end and nothing here knows which chunk holds them; harmless where
    // there is no authorial voice, and the one place it bites — Morphotrophic's
    // afterword — cost a man a feminine verb in his own acknowledgements.
    if (authorGender && passport.author?.name) {
        lines.push(words.authorVoice(passport.author.name, words.genderShort[authorGender]));
    }

    if (person === 'first' || person === 'second') {
        let focalName = povForChunk(passport, chunkIndex);
        if (!focalName && cast.length === 1) focalName = cast[0].name;
        focal = findCharacter(passport, focalName);

        if (focal && (focal.gender === 'm' || focal.gender === 'f')) {
            lines.push(words.focal(focal.name, words.gender[focal.gender]));
            if (focal.dossier) {
                lines.push(words.dossier(fitToTokens(focal.dossier, DOSSIER_TOKENS)));
                dossiersShown++;
            }
        } else if (cast.length) {
            lines.push(words.undetermined);
        }
    }

    // Dossiers of the other cast members named in this chunk. The dossier
    // carries the relationships — rank, subordination, family — that a
    // translator needs to pick the right form of address in dialogue; a pair
    // registry was deliberately rejected in favour of letting the translator
    // infer address from these (owner's call: "переводчик сам разберётся,
    // если дать ему адекватные досье").
    if (chunkText) {
        for (const member of cast) {
            if (!member?.name || !member.dossier) continue;
            if (focal && member.name.toLowerCase() === focal.name.toLowerCase()) continue;
            if (wholeWordRegex(member.name, 'iu').test(chunkText)) {
                lines.push(words.other(member.name, fitToTokens(member.dossier, DOSSIER_TOKENS)));
                dossiersShown++;
            }
        }
    }

    // Only point at the dossiers when at least one is actually in the prompt.
    if (dossiersShown > 0) lines.push(words.dialogueAddress);

    return lines.join('\n');
}

/** True when the passport carries nothing worth injecting into a prompt. */
export function isEmptyPassport(passport) {
    if (!passport) return true;
    const { narration, characters, povMap, addressRegistry, voices, dialogue, author } = passport;
    const narrationSet = narration && (narration.person || narration.tense || narration.addressForm);
    return !narrationSet
        && !(characters || []).length
        && !(povMap || []).length
        && !(addressRegistry || []).length
        && !(voices || []).length
        && !dialogue?.marker
        && !author?.gender;
}
