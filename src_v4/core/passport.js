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
