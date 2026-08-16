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

export const PASSPORT_VERSION = 1;

/**
 * @typedef {Object} Passport
 * @property {number} version
 * @property {string} updatedAt
 * @property {{model: string|null, generatedAt: string|null}} source
 *   Which model produced the generated parts, and when. Hand edits leave this
 *   alone, so it always answers "where did this come from".
 * @property {{person: 'first'|'second'|'third'|null,
 *             tense: 'present'|'past'|null,
 *             addressForm: string|null}} narration
 *   addressForm is how the narration addresses the reader in second person.
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
 */

/** A passport with nothing decided yet. */
export function emptyPassport() {
    return {
        version: PASSPORT_VERSION,
        updatedAt: new Date().toISOString(),
        source: { model: null, generatedAt: null },
        narration: { person: null, tense: null, addressForm: null },
        characters: [],
        povMap: [],
        addressRegistry: [],
        voices: [],
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
            source: { ...base.source, ...(raw.source || {}) },
            narration: { ...base.narration, ...(raw.narration || {}) },
            characters: Array.isArray(raw.characters) ? raw.characters : [],
            povMap: Array.isArray(raw.povMap) ? raw.povMap : [],
            addressRegistry: Array.isArray(raw.addressRegistry) ? raw.addressRegistry : [],
            voices: Array.isArray(raw.voices) ? raw.voices : [],
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

// Wording tables for the <style> block, keyed by prompt language.
const STYLE_WORDS = {
    ru: {
        person: { first: 'от 1-го лица', second: 'от 2-го лица («ты»/«вы» — читатель смотрит глазами персонажа)', third: 'от 3-го лица' },
        tense: { present: 'настоящее время', past: 'прошедшее время' },
        narration: (p, t) => `Повествование: ${[p, t ? `основное время — ${t}` : null].filter(Boolean).join(', ')}. ЭТАЛОН ВРЕМЕНИ — ОРИГИНАЛ, фраза за фразой: где автор пишет в прошедшем (воспоминания, события до момента повествования), прошедшее сохраняется — это НЕ нарушение.`,
        address: (form) => `Обращение к читателю в АВТОРСКОМ ПОВЕСТВОВАНИИ: ${form}. Не переключайся между «ты» и «вы» в повествовании. На обращения персонажей друг к другу (диалоги, письма, протоколы, чаты) это правило НЕ распространяется — там уместно и вежливое «вы».`,
        gender: { m: 'МУЖЧИНА — все родовые формы (глаголы прошедшего времени, прилагательные, причастия), относящиеся к повествователю, мужского рода', f: 'ЖЕНЩИНА — все родовые формы (глаголы прошедшего времени, прилагательные, причастия), относящиеся к повествователю, женского рода' },
        focal: (name, genderTxt) => `Повествователь этого фрагмента: ${name}, ${genderTxt}.`,
        dossier: (text) => `Досье повествователя: ${text}`,
        other: (name, text) => `Также в этом фрагменте: ${name}. Досье: ${text}`,
        dialogueAddress: 'В диалогах форму обращения («ты»/«вы») выбирай по отношениям персонажей из досье: подчинённые к начальству, свидетели к полиции, незнакомцы и деловые собеседники — обычно на «вы»; близкие, семья и приятели — на «ты».',
        undetermined: 'Кто повествователь этого фрагмента — НЕ определено. НЕ приписывай повествователю род: держи время повествования и перестраивай фразы так, чтобы родовые формы не требовались.',
    },
    en: {
        person: { first: 'first person', second: 'second person (the reader sees through a character\'s eyes)', third: 'third person' },
        tense: { present: 'present tense', past: 'past tense' },
        narration: (p, t) => `Narration: ${[p, t ? `base tense — ${t}` : null].filter(Boolean).join(', ')}. THE TENSE AUTHORITY IS THE ORIGINAL, phrase by phrase: where the author writes in the past (memories, events before the narrative moment), the past is kept — that is NOT a violation.`,
        address: (form) => `Form of address to the reader in the AUTHOR'S NARRATION: ${form}. Never switch between formal and informal in the narration. This rule does NOT extend to characters addressing each other (dialogue, letters, transcripts, chats) — polite address is appropriate there.`,
        gender: { m: 'MALE — every gendered form (past-tense verbs, adjectives, participles) referring to the narrator must be masculine', f: 'FEMALE — every gendered form (past-tense verbs, adjectives, participles) referring to the narrator must be feminine' },
        focal: (name, genderTxt) => `The narrator of this fragment: ${name}, ${genderTxt}.`,
        dossier: (text) => `Narrator's dossier: ${text}`,
        other: (name, text) => `Also in this fragment: ${name}. Dossier: ${text}`,
        dialogueAddress: 'In dialogue, choose the form of address (formal/informal) from the characters\' relationships in the dossiers: subordinates to superiors, witnesses to police, strangers and business contacts are usually formal; family and close friends informal.',
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
    const personTxt = words.person[person] || null;
    const tenseTxt = words.tense[tense] || null;
    if (personTxt || tenseTxt) lines.push(words.narration(personTxt, tenseTxt));
    if (addressForm) lines.push(words.address(addressForm));

    const cast = passport.characters || [];
    let focal = null;
    let dossiersShown = 0;

    if (person === 'first' || person === 'second') {
        let focalName = povForChunk(passport, chunkIndex);
        if (!focalName && cast.length === 1) focalName = cast[0].name;
        focal = findCharacter(passport, focalName);

        if (focal && (focal.gender === 'm' || focal.gender === 'f')) {
            lines.push(words.focal(focal.name, words.gender[focal.gender]));
            if (focal.dossier) {
                lines.push(words.dossier(String(focal.dossier).slice(0, 500)));
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
                lines.push(words.other(member.name, String(member.dossier).slice(0, 300)));
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
    const { narration, characters, povMap, addressRegistry, voices } = passport;
    const narrationSet = narration && (narration.person || narration.tense || narration.addressForm);
    return !narrationSet
        && !(characters || []).length
        && !(povMap || []).length
        && !(addressRegistry || []).length
        && !(voices || []).length;
}
