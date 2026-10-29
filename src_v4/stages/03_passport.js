/**
 * Build the book passport: one whole-book call plus the parts that are cheaper
 * and more accurate to compute.
 *
 * The split is deliberate. Measured against chapter headings in an existing
 * project, asking a model which character narrates each segment scored 66%,
 * while anchors plus a rotation prior scored 100% — so the model is asked only
 * for the cast and their dossiers, which no amount of counting can supply, and
 * the map itself is computed. Narrative person and pronoun-based gender go into
 * the prompt as evidence rather than as questions, for the same reason.
 */

import fs from 'fs';
import { HumanMessage } from '@langchain/core/messages';
import { llmManager, bookModelEnabled, explainCallFailure } from '../core/llm_client.js';
import { usageTracker } from '../core/usage_tracker.js';
import { extractJson } from '../utils/parsers.js';
import { detectNarrativePerson, characterCandidates, nameRegex } from '../core/text_stats.js';
import { buildPovMap, describePovMap } from '../core/pov_map.js';
import { spansFromQuotes } from '../core/quoted_spans.js';
import { splitTextIntoChunks, chunkTokens, countTokens } from '../core/tokenizer.js';
import { fingerprint, fingerprintMismatch } from '../core/book_call.js';
import { carryExtraction } from '../core/rechunk.js';
import { loadPassport, savePassport, handEdited, acceptedNotes, mergeNotes } from '../core/passport.js';
import { profileForText, reloadLearnedProfiles } from '../core/language.js';
import { learnLanguageProfile, validateLanguageProfile, saveLearnedProfile } from '../core/language_learn.js';
import config from '../config.js';
import { getPrompts } from '../prompts.js';

// Above this the prompt is unlikely to fit a provider's per-minute token budget
// even when it fits the model's context window, so warn rather than fail late.
// The same number the other whole-book calls are held to: 200,000 stood here
// while the measured ceiling turned out to be under 168,000, so the warning
// would have stayed quiet through a refusal.
// Read when used, not when loaded: the GUI server loads this once and keeps it
// for days, while the setting can change under it (see reloadConfig).
const largeBookTokens = () => config.pipeline.bookCallTokenBudget;

function normalizeGender(value) {
    const s = String(value || '').trim().toLowerCase();
    if (['m', 'male', 'м', 'муж'].includes(s)) return 'm';
    if (['f', 'female', 'ж', 'жен'].includes(s)) return 'f';
    if (['n', 'neuter', 'с', 'ср'].includes(s)) return 'n';
    return null;
}

function normalizePerson(value) {
    const s = String(value || '').trim().toLowerCase();
    if (s.startsWith('first') || s.startsWith('перв') || s === '1') return 'first';
    if (s.startsWith('second') || s.startsWith('втор') || s === '2') return 'second';
    if (s.startsWith('third') || s.startsWith('трет') || s === '3') return 'third';
    return null;
}

function normalizeTense(value) {
    const s = String(value || '').trim().toLowerCase();
    if (s.startsWith('present') || s.startsWith('наст')) return 'present';
    if (s.startsWith('past') || s.startsWith('прош')) return 'past';
    return null;
}

/**
 * The address form must be a bare pronoun — it is substituted into prompts as a
 * value. Models pack explanations into it anyway ("ты (с изменением
 * грамматического рода...)"), so the first word is kept as the form and the
 * rest is preserved separately as a note instead of being lost.
 * @returns {{form: string|null, note: string|null}}
 */
function normalizeAddressForm(raw) {
    const s = String(raw || '').trim();
    if (!s) return { form: null, note: null };
    const m = s.match(/^[«"'‘]?([\p{L}]{1,15})[»"'’]?/u);
    if (!m) return { form: null, note: s };
    const rest = s.slice(m[0].length).replace(/^[\s—–:,-]*/, '').replace(/^\((.*)\)$/s, '$1').trim();
    return { form: m[1], note: rest || null };
}

/**
 * What the model is to be asked, and what it adds up to.
 *
 * Split from applying the answer so the call between them can be made by hand
 * when a provider refuses one this size — see core/book_call.js. Both routes
 * share the halves, so an answer carried from a web console is normalised and
 * checked exactly as an API one is.
 *
 * Learning an unknown language is NOT here: it is a second model call, and the
 * manual route has no client to make it with. A book in a language the measuring
 * layer does not know still gets a passport, only without the pronoun evidence.
 *
 * @throws {Error} when there is nothing to build a passport from
 */
export function buildPassportPrompt(state) {
    const chunks = state.getChunks();
    if (!chunks.length) throw new Error('Project has no chunks yet — run the extraction first.');

    const bookText = chunks.map(c => c.original).join('\n');
    const glossary = readGlossary(state);
    const targetLang = state.data.metadata?.targetLanguage || config.translation.targetLanguage;
    const prompts = getPrompts(config.translation.promptLang);

    const person = detectNarrativePerson(bookText);
    const candidates = characterCandidates(bookText, glossary, 25);

    // What the owner typed for the export is worth more than what the model can
    // infer from a text that may never name its author. Passed as evidence rather
    // than substituted afterwards, so the gender it returns is about the right
    // person.
    const knownAuthor = String(state.data.metadata?.book?.author || '').trim() || undefined;

    // Notes accepted on an earlier run survive the rebuild, so the model is shown
    // them — otherwise it proposes them again and they have to be rejected again.
    const accepted = acceptedNotes(loadPassport(state.getPassportPath()))
        .map(n => ({ topic: n.topic || undefined, advice: n.advice }));

    const evidence = {
        knownAuthor,
        acceptedNotes: accepted.length ? accepted : undefined,
        narrativePerson: { detected: person.person, share: Number(person.share.toFixed(2)), counts: person.counts },
        characterCandidates: candidates.map(c => ({
            name: c.name,
            mentions: c.count,
            shareInSpeech: Number(c.speechShare.toFixed(2)),
            genderByPronouns: c.gender,
            pronouns: c.pronouns,
            glossaryNote: c.notes || undefined,
        })),
    };

    const system = prompts.passport.system(targetLang);
    const user = prompts.passport.user(bookText, evidence);
    const tokens = {
        book: chunkTokens(chunks),
        evidence: countTokens(JSON.stringify(evidence, null, 1)),
        instructions: countTokens(system),
    };
    tokens.total = tokens.book + tokens.evidence + tokens.instructions;

    return {
        system, user, tokens, person, candidates, knownAuthor,
        budget: largeBookTokens(),
        // Over the source text: the quoted point-of-view boundaries are located in
        // it, and an answer made from a different version would place them wrongly.
        fingerprint: fingerprint(bookText),
        warnings: [],
    };
}

/** The glossary as a plain array, or empty when there is none to read. */
function readGlossary(state) {
    const path = state.getGlossaryPath();
    if (!fs.existsSync(path)) return [];
    try {
        const glossary = JSON.parse(fs.readFileSync(path, 'utf-8'));
        return Array.isArray(glossary) ? glossary : [];
    } catch (e) {
        console.warn(`[Passport] Could not read the glossary: ${e.message}`);
        return [];
    }
}

export async function runPassportStage(state) {
    console.log('--- SYSTEM: Building book passport ---');
    usageTracker.setStage('passport');

    if (!bookModelEnabled()) {
        console.error('[Passport] The large model is switched off (book_model.enabled), and the passport is built ' +
            'by one call to it. Turn it on in Settings → Large model.');
        process.exitCode = 1;
        return;
    }

    let built;
    try {
        built = buildPassportPrompt(state);
    } catch (e) {
        console.error(`[Passport] ${e.message}`);
        process.exitCode = 1;
        return;
    }

    const chunks = state.getChunks();
    const bookText = chunks.map(c => c.original).join('\n');
    const prompts = getPrompts(config.translation.promptLang);
    console.log(`[Passport] Book: ${chunks.length} chunks, ~${built.tokens.total.toLocaleString('en-US')} tokens.`);
    if (built.tokens.total > largeBookTokens()) {
        console.warn(`[Passport] WARNING: this is a large prompt. Free tiers cap INPUT tokens per minute ` +
            `below the documented total, and the call may be refused even though the model's context ` +
            `window fits it (pipeline.bookCallTokenBudget is ${largeBookTokens().toLocaleString('en-US')}). ` +
            `The passport page can hand you this prompt to run in a web console instead.`);
    }

    // --- an unknown language is learned once, before anything is measured ---
    // Without a profile the measuring layer is blind (and, before it learned to
    // admit that, actively wrong: Polish read as first person because "i" means
    // "and"). The profile belongs to the language, not the book, so it is stored
    // in a shared file and this call happens once per language ever.
    let client, conf, provider;
    try {
        ({ conf, provider } = llmManager.getBookSettings());
        client = llmManager.getClient('book');
    } catch (e) {
        console.error(`[Passport] The large model is not configured: ${e.message}`);
        process.exitCode = 1;
        return;
    }
    const detected = profileForText(bookText);
    if (!detected.lang) {
        console.log(`[Passport] Language not recognised (script: ${detected.script}) — asking ${conf.modelName} for its profile...`);
        try {
            const proposed = await learnLanguageProfile(client, prompts, bookText);
            const { ok, checks } = validateLanguageProfile(proposed, bookText);
            for (const c of checks) console.log(`[Passport]   ${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`);
            if (ok) {
                const lang = String(proposed.language).toLowerCase();
                saveLearnedProfile(lang, proposed);
                reloadLearnedProfiles();
                console.log(`[Passport] Learned "${proposed.languageName}" (${lang}) and saved it — every check passed.`);
            } else {
                console.warn(`[Passport] The proposed profile failed validation and was NOT saved. ` +
                    `Language-dependent measurements stay unavailable for this book.`);
            }
        } catch (e) {
            console.warn(`[Passport] Could not learn the language profile: ${e.message}`);
        }
    }

    console.log(`[Passport] Narrative person by pronoun counts: ${built.person.person || 'unclear'} ` +
        `(${Math.round(built.person.share * 100)}% of counted pronouns).`);
    console.log(`[Passport] ${built.candidates.length} character candidate(s) prepared as evidence.`);
    if (built.knownAuthor) console.log(`[Passport] Book metadata names the author as "${built.knownAuthor}" — passing it as evidence.`);

    console.log(`[Passport] Asking ${conf.modelName} for the point-of-view cast and dossiers...`);

    let answer;
    try {
        const response = await client.invoke([
            new HumanMessage(built.system),
            new HumanMessage(built.user),
        ]);
        answer = extractJson(response.content || '');
    } catch (e) {
        console.error(`[Passport] The whole-book call failed — ${explainCallFailure(e, provider, conf)}`);
        if (e.contentBlocked) {
            console.error('[Passport] The provider refused the text. Retrying will not help — switch the book_model provider.');
        }
        process.exitCode = 1;
        return;
    }

    let passport;
    try {
        ({ passport } = applyPassportAnswer(state, answer, { model: conf.modelName, fingerprint: built.fingerprint }));
    } catch (e) {
        console.error(`[Passport] ${e.message}`);
        process.exitCode = 1;
        return;
    }
}

/**
 * Take the answer, normalise it, and record the passport.
 *
 * Everything the model returns passes through here whoever obtained it: the
 * fields are normalised, the point-of-view map is computed rather than trusted,
 * and a hand-edited passport is backed up before being replaced.
 *
 * @throws {Error} when the answer does not belong to this text
 */
export function applyPassportAnswer(state, answer, meta) {
    let chunks = state.getChunks();
    const bookText = chunks.map(c => c.original).join('\n');
    const glossary = readGlossary(state);
    const targetLang = state.data.metadata?.targetLanguage || config.translation.targetLanguage;
    const prompts = getPrompts(config.translation.promptLang);
    const person = detectNarrativePerson(bookText);
    const candidates = characterCandidates(bookText, glossary, 25);
    const knownAuthor = String(state.data.metadata?.book?.author || '').trim() || undefined;
    const conf = { modelName: meta.model || null };

    const stale = fingerprintMismatch(fingerprint(bookText), meta.fingerprint);
    if (stale) throw new Error(stale);

    // --- merge: the model's answer, then the map computed from it ---
    const passportPath = state.getPassportPath();
    const passport = loadPassport(passportPath);

    // Everything this stage computes it overwrites: narration, the cast and
    // their dossiers, the map. The editor invites those to be corrected by hand,
    // and a second run would take the corrections back without asking. Keep a
    // copy — a backup nobody needs costs a few kilobytes, a lost dossier costs
    // the reading of a whole book.
    if (handEdited(passport)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const backup = `${passportPath}.${stamp}.bak`;
        try {
            fs.copyFileSync(passportPath, backup);
            console.warn(`[Passport] This passport was edited by hand after it was generated. ` +
                `The model's answer replaces narration and the cast; your copy is kept as ` +
                `${backup.split(/[\\/]/).pop()}.`);
        } catch (e) {
            throw new Error(`Could not back up the hand-edited passport (${e.message}) — nothing was overwritten.`);
        }
    }

    // Non-fiction is the answer that changes behaviour, so it has to be stated;
    // anything unrecognized falls back to fiction, which is what the pipeline
    // did before this field existed.
    const kindRaw = String(answer?.kind || '').trim().toLowerCase();
    passport.kind = /non-?fiction|нехудож|документ|публицист/.test(kindRaw) ? 'nonfiction' : 'fiction';
    // A register is substituted into the prompt as a value: keep it a phrase.
    const registerRaw = String(answer?.register || '').trim();
    passport.register = registerRaw ? registerRaw.split(/[.;\n]/)[0].trim().slice(0, 80) : null;

    // --- who wrote it ---
    // The gender is the point: it governs "I" in the preface, the afterword and
    // the acknowledgements, where the narrator's gender does not apply. Recorded
    // with the model's own account of where it came from, because unlike almost
    // everything else in this passport it cannot be checked against the book —
    // a book need never name its author, let alone their gender.
    const authorName = String(answer?.author?.name || knownAuthor || '').trim().slice(0, 120);
    const authorGender = normalizeGender(answer?.author?.gender);
    // Whether the book itself names them. Strict — this exact name, whole words:
    // a false here says "not verifiable from the text", which is true even when
    // the book spells the name some other way, and erring toward unverifiable is
    // the safe direction. Whole words matter more than they look: a bare
    // substring search finds "Egan" 92 times in Morphotrophic, 89 of them inside
    // the word "began".
    const inText = authorName ? nameRegex(authorName, 'u').test(bookText) : false;
    passport.author = (authorName || authorGender)
        ? {
            name: authorName || null,
            gender: authorGender,
            inText,
            note: String(answer?.author?.reason || '').trim().slice(0, 200) || null,
        }
        : null;
    console.log(passport.author?.gender
        ? `[Passport] Author: ${passport.author.name || 'unnamed'} (${passport.author.gender}), ` +
          `${inText ? 'named in the book itself' : 'NOT named anywhere in the book — the model recognised it'}` +
          `${passport.author.note ? ` — ${passport.author.note}` : '.'}`
        : `[Passport] Author: gender not established — the prompts will say nothing about the author's voice.`);

    // --- how direct speech is set ---
    // A norm of the target language, settled here, before a word is translated.
    // Deliberately NOT read off the book: neither the original, whose convention
    // is the one thing that must not be carried across, nor the translation,
    // where the majority would be right by definition and a book translated
    // badly would teach the passport its own mistake.
    //
    // A marker set by hand outranks the model, as every other passport field
    // does: rebuilding the cast is no reason to revisit a typographic decision
    // somebody already made.
    if (passport.dialogue?.source === 'hand' && passport.dialogue.marker) {
        console.log(`[Passport] Direct speech: keeping "${passport.dialogue.marker}", set by hand.`);
    } else {
        const marker = String(answer?.dialogue?.marker || '').trim().slice(0, 4);
        passport.dialogue = marker
            ? { marker, sample: String(answer?.dialogue?.sample || '').trim().slice(0, 140) || null, source: 'model' }
            : null;
        console.log(passport.dialogue
            ? `[Passport] Direct speech in ${targetLang} is set with "${passport.dialogue.marker}".`
            : `[Passport] Direct speech: the model named no marker — left unset, and nothing will be said about it in the prompts.`);
    }

    // --- the book's description, for the e-reader ---
    // Kept in the passport as the model gave it, and copied into the export
    // fields only where those are empty: a title or blurb typed by a person is
    // never replaced by a rebuild.
    const bookRaw = answer?.book && typeof answer.book === 'object' ? answer.book : {};
    const described = {
        title: String(bookRaw.title || '').trim().slice(0, 300) || null,
        titleSource: bookRaw.titleSource === 'published' ? 'published' : (bookRaw.title ? 'translated' : null),
        author: String(bookRaw.author || '').trim().slice(0, 300) || null,
        annotation: String(bookRaw.annotation || '').replace(/\r\n?/g, '\n').trim().slice(0, 3000) || null,
    };
    passport.book = described.title || described.author || described.annotation ? described : null;
    if (passport.book) {
        const meta = state.data.metadata = state.data.metadata || {};
        const fields = meta.book = meta.book || {};
        const filled = ['title', 'author', 'annotation'].filter(k => !String(fields[k] || '').trim() && described[k]);
        for (const k of filled) fields[k] = described[k];
        if (filled.length) {
            state.save();
            console.log(`[Passport] Book page: filled ${filled.join(', ')} from the model` +
                `${filled.includes('title') ? ` (title ${described.titleSource === 'published' ? 'of a published edition, by the model\'s account' : 'translated'})` : ''}.`);
        }
    }

    // --- notes for the translator ---
    // Proposals only: none reaches a prompt until a person accepts it.
    passport.notes = mergeNotes(passport.notes, answer?.notes);
    const proposed = passport.notes.filter(n => n.status === 'proposed').length;
    console.log(proposed
        ? `[Passport] ${proposed} note(s) for the translator proposed — accept or reject them on the passport page.`
        : `[Passport] No new notes for the translator.`);

    const address = normalizeAddressForm(answer?.narration?.addressForm);
    passport.narration = {
        person: normalizePerson(answer?.narration?.person) || person.person,
        tense: normalizeTense(answer?.narration?.tense),
        addressForm: address.form,
        // Whatever the model wanted to say beyond the bare form, plus its
        // stated reasoning — kept for the human, never substituted into prompts.
        addressNote: [address.note, answer?.narration?.reason].filter(Boolean).join(' | ') || null,
    };

    const cast = Array.isArray(answer?.povCharacters) ? answer.povCharacters : [];
    passport.characters = cast
        .filter(c => c && c.name)
        .map(c => {
            const measured = candidates.find(x => x.name.toLowerCase() === String(c.name).toLowerCase());
            return {
                name: String(c.name).trim(),
                // Pronoun evidence only fills a gap; it never overrides the model,
                // which has read the whole book and can see titled and place names
                // for what they are.
                gender: normalizeGender(c.gender) || measured?.gender || null,
                dossier: String(c.dossier || '').trim(),
            };
        });

    const castNames = passport.characters.map(c => c.name);

    // The map is computed: anchors plus a rotation prior score 99.4% on
    // chapter-aligned chunks and cost nothing. What that cannot see — a book
    // whose point of view changes without any chapter heading to key off — is a
    // separate whole-book call (runPovMapStage), offered only when it is needed:
    // both multi-narrator books so far needed it, the other four had one
    // narrator and no map to draw.
    const previous = { map: passport.povMap || [], from: passport.source?.povMapFrom, model: passport.source?.povMapModel, at: passport.source?.povMapAt };
    passport.povMap = buildPovMap(chunks, castNames);
    let mapSource = 'anchors';
    let mapMeta = {};

    // A map from quoted boundaries was paid for with a whole-book call of its
    // own. Rebuilding the passport is no reason to throw it away, as long as it
    // still speaks of this cast.
    if (castNames.length > 1 && !passport.povMap.length && previous.from === 'quotes' && previous.map.length) {
        const known = new Set(castNames.map(n => n.toLowerCase()));
        if (previous.map.every(s => !s.character || known.has(String(s.character).toLowerCase()))) {
            passport.povMap = previous.map;
            mapSource = 'quotes';
            mapMeta = { povMapModel: previous.model, povMapAt: previous.at };
            console.log(`[Passport] No anchors found — keeping the map from quoted boundaries built earlier (${previous.map.length} span(s)).`);
        }
    }

    passport.source = { model: conf.modelName, generatedAt: new Date().toISOString(), povMapFrom: mapSource, ...mapMeta };

    savePassport(passportPath, passport);

    // --- report ---
    const { person: p, tense, addressForm } = passport.narration;
    console.log(`[Passport] Kind: ${passport.kind}${passport.register ? `, register: ${passport.register}` : ''}.`);
    if (passport.kind === 'nonfiction' && p === 'second') {
        console.log(`[Passport] Second person in non-fiction: "you" is the reader — addressed as ${passport.readerGender || 'm'}, ` +
            `not given a character's gender.`);
    }
    console.log(`[Passport] Narration: ${p || '—'}, ${tense || '—'}${addressForm ? `, addressing the reader as "${addressForm}"` : ''}.`);
    for (const c of passport.characters) {
        console.log(`[Passport]   ${c.name} (${c.gender || 'gender unknown'}): ${c.dossier.slice(0, 90)}`);
    }

    if (castNames.length > 1) {
        const stats = describePovMap(chunks, castNames);
        const covered = passport.povMap.reduce((n, s) => n + (s.toChunk - s.fromChunk + 1), 0);
        console.log(`[Passport] Point-of-view map: ${passport.povMap.length} span(s) over ${covered}/${chunks.length} chunks, ` +
            `from ${mapSource === 'quotes' ? 'quoted boundaries asked for earlier' : 'anchors + rotation'} ` +
            `(${stats.anchors} of ${stats.segments} segments carried an anchor).`);
        if (!passport.povMap.length) {
            console.warn('[Passport] No anchors to build the map on. Ask for the point-of-view boundaries — the button is on ' +
                'the passport page, or --stage=povmap. Until then chunks stay undetermined, and the translation prompt ' +
                'is told to avoid gendered forms rather than guess.');
        }
    } else if (castNames.length === 1) {
        console.log(`[Passport] Single narrator (${castNames[0]}) — no map needed, the decision holds for the whole book.`);
    }

    console.log(`[Passport] Saved to ${state.getPassportPath().split(/[\\/]/).pop()}`);
    console.log('--- SYSTEM: Book passport completed ---');
    return { passport, chunks };
}

// ============================================================
// Point-of-view boundaries: a whole-book call of their own
// ============================================================

/**
 * What the model is to be asked for the boundaries. Split from applying the
 * answer for the same reason as the passport: the call can be carried by hand.
 *
 * @throws {Error} when there is no cast to draw a map between
 */
export function buildPovMapPrompt(state) {
    const chunks = state.getChunks();
    if (!chunks.length) throw new Error('Project has no chunks yet — run the extraction first.');
    const passport = loadPassport(state.getPassportPath());
    const cast = (passport.characters || []).filter(c => c?.name);
    if (cast.length < 2) {
        throw new Error('The passport names fewer than two point-of-view characters — there is no map to draw. Build the passport first.');
    }

    const bookText = chunks.map(c => c.original).join('\n');
    const prompts = getPrompts(config.translation.promptLang);
    // Names and genders only. The dossiers would help tell the narrators apart,
    // but they run to 600 tokens each and the names alone are what the answer
    // has to match.
    const castBrief = cast.map(c => ({ name: c.name, gender: c.gender || undefined }));
    const system = prompts.povMap.system();
    const user = prompts.povMap.user(bookText, castBrief);
    const tokens = {
        book: chunkTokens(chunks),
        evidence: countTokens(JSON.stringify(castBrief, null, 1)),
        instructions: countTokens(system),
    };
    tokens.total = tokens.book + tokens.evidence + tokens.instructions;

    const translated = chunks.filter(c => c.translation).length;
    return {
        system, user, tokens,
        budget: largeBookTokens(),
        fingerprint: fingerprint(bookText),
        warnings: translated
            ? [`${translated} chunk(s) are already translated, so the text will not be re-split on the boundaries.`]
            : [],
    };
}

/**
 * Take the boundaries, locate them, and put the map into the passport —
 * re-splitting the text on them while nothing has been translated.
 *
 * @throws {Error} when the answer does not belong to this text, or locates nothing
 */
export function applyPovMapAnswer(state, answer, meta) {
    let chunks = state.getChunks();
    const bookText = chunks.map(c => c.original).join('\n');
    const stale = fingerprintMismatch(fingerprint(bookText), meta.fingerprint);
    if (stale) throw new Error(stale);

    const passportPath = state.getPassportPath();
    const passport = loadPassport(passportPath);
    const castNames = (passport.characters || []).map(c => c.name).filter(Boolean);
    if (castNames.length < 2) throw new Error('The passport names fewer than two point-of-view characters — there is no map to draw.');

    const spans = answer?.povSpans;
    const { map, offsets, stats } = spansFromQuotes(chunks, spans, castNames);
    console.log(`[POV map] Quoted boundaries: ${stats.located}/${stats.total} located` +
        `${stats.missing ? `, ${stats.missing} not in the text` : ''}` +
        `${stats.ambiguous ? `, ${stats.ambiguous} ambiguous` : ''}` +
        `${stats.outOfOrder ? `, ${stats.outOfOrder} out of order` : ''}` +
        `${stats.unknownCharacter ? `, ${stats.unknownCharacter} naming someone outside the cast` : ''}.`);
    if (!map.length) {
        throw new Error(`None of the ${stats.total} quoted boundaries could be located in the text — the map is left as it was.`);
    }
    passport.povMap = map;

    // These boundaries arrive after the text was already split, and they land
    // mid-chunk far more often than not (measured: 28 of 36, median 847
    // characters from the nearest edge). A chunk straddling a change of narrator
    // gets one label for two people, which is precisely the defect the map exists
    // to prevent. Re-split with the boundaries as hard break points — but only
    // while nothing has been translated, since re-splitting renumbers the chunks
    // and would orphan the work.
    const translated = chunks.filter(c => c.translation).length;
    if (translated) {
        console.warn(`[POV map] ${translated} chunk(s) already translated, so the text is not re-split. ` +
            `Boundaries stay buried inside chunks and those chunks carry two narrators; ` +
            `a fresh project on the same source would be cut cleanly.`);
    } else {
        const source = chunks.map(c => c.original).join('');
        const resplit = splitTextIntoChunks(source, offsets);

        // The splitter returns bare chunks, so the extraction's work has to be
        // moved across by hand — otherwise a re-split silently throws away every
        // extracted term and they have to be paid for again.
        const { chunks: carried, stats: carry, refused } = carryExtraction(chunks, resplit);
        const hadTerms = chunks.some(c => c.extracted_terms?.length);

        if (refused && hadTerms) {
            console.warn(`[POV map] NOT re-splitting: ${refused}. ` +
                `The map stands, but chunks straddling a change of narrator stay as they are — ` +
                `losing ${chunks.reduce((n, c) => n + (c.extracted_terms?.length || 0), 0)} extracted term(s) ` +
                `would cost more than the cleaner cut is worth.`);
        } else {
            state.setChunks(carried);
            state.save();
            console.log(`[POV map] Re-split on ${offsets.length} point-of-view boundaries: ` +
                `${chunks.length} → ${carried.length} chunks, none spanning a change of narrator.`);
            if (carry.terms) {
                console.log(`[POV map] Carried ${carry.terms} extracted term(s) across: ` +
                    `${carry.located} placed by locating their text` +
                    `${carry.fallback ? `, ${carry.fallback} by overlap because the recorded form does not occur verbatim` : ''}` +
                    `; ${carry.extracted}/${carried.length} chunk(s) stay marked as extracted.`);
            }
            chunks = carried;
        }
        // Indices changed with the split, so the map is rebuilt against the new
        // chunks; the old one stands if that somehow yields less.
        const rebuilt = spansFromQuotes(chunks, spans, castNames);
        if (rebuilt.map.length) passport.povMap = rebuilt.map;
    }

    // povMapAt tells handEdited that this save was the model's. Stamped only
    // when the passport had no hand edits already: otherwise the stamp would
    // hide them, and a rebuild would replace them without the backup.
    const edited = handEdited(passport);
    passport.source = {
        ...passport.source,
        povMapFrom: 'quotes',
        povMapModel: meta.model || null,
        povMapAt: edited ? passport.source?.povMapAt || null : new Date().toISOString(),
    };
    savePassport(passportPath, passport);

    const covered = passport.povMap.reduce((n, s) => n + (s.toChunk - s.fromChunk + 1), 0);
    console.log(`[POV map] ${passport.povMap.length} span(s) over ${covered}/${chunks.length} chunks. ` +
        `Saved to ${passportPath.split(/[\\/]/).pop()}`);
    console.log('--- SYSTEM: Point-of-view map completed ---');
    return { passport, chunks };
}

export async function runPovMapStage(state) {
    console.log('--- SYSTEM: Asking for the point-of-view boundaries ---');
    usageTracker.setStage('povmap');

    if (!bookModelEnabled()) {
        console.error('[POV map] The large model is switched off (book_model.enabled), and the boundaries are found by ' +
            'one call to it. Turn it on in Settings → Large model.');
        process.exitCode = 1;
        return;
    }

    let built;
    try {
        built = buildPovMapPrompt(state);
    } catch (e) {
        console.error(`[POV map] ${e.message}`);
        process.exitCode = 1;
        return;
    }
    for (const w of built.warnings) console.warn(`[POV map] ${w}`);
    console.log(`[POV map] Book: ${state.getChunks().length} chunks, ~${built.tokens.total.toLocaleString('en-US')} tokens.`);

    let client, conf, provider;
    try {
        ({ conf, provider } = llmManager.getBookSettings());
        client = llmManager.getClient('book');
    } catch (e) {
        console.error(`[POV map] The large model is not configured: ${e.message}`);
        process.exitCode = 1;
        return;
    }

    console.log(`[POV map] Asking ${conf.modelName} where the point of view changes...`);
    let answer;
    try {
        const response = await client.invoke([
            new HumanMessage(built.system),
            new HumanMessage(built.user),
        ]);
        answer = extractJson(response.content || '');
    } catch (e) {
        console.error(`[POV map] The whole-book call failed — ${explainCallFailure(e, provider, conf)}`);
        if (e.contentBlocked) {
            console.error('[POV map] The provider refused the text. Retrying will not help — switch the book_model provider.');
        }
        process.exitCode = 1;
        return;
    }

    try {
        applyPovMapAnswer(state, answer, { model: conf.modelName, fingerprint: built.fingerprint });
    } catch (e) {
        console.error(`[POV map] ${e.message}`);
        process.exitCode = 1;
    }
}
