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
import { llmManager } from '../core/llm_client.js';
import { usageTracker } from '../core/usage_tracker.js';
import { extractJson } from '../utils/parsers.js';
import { detectNarrativePerson, characterCandidates } from '../core/text_stats.js';
import { buildPovMap, describePovMap } from '../core/pov_map.js';
import { spansFromQuotes } from '../core/quoted_spans.js';
import { splitTextIntoChunks } from '../core/tokenizer.js';
import { loadPassport, savePassport } from '../core/passport.js';
import config from '../config.js';
import { getPrompts } from '../prompts.js';

// Above this the prompt is unlikely to fit a provider's per-minute token budget
// even when it fits the model's context window, so warn rather than fail late.
const LARGE_BOOK_TOKENS = 200000;

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

export async function runPassportStage(state) {
    console.log('--- SYSTEM: Building book passport ---');
    usageTracker.setStage('passport');

    let chunks = state.getChunks();
    if (!chunks.length) {
        console.error('[Passport] Project has no chunks yet — run Stage 1 first.');
        return;
    }

    const bookText = chunks.map(c => c.original).join('\n');
    const approxTokens = Math.round(bookText.length / 4);
    console.log(`[Passport] Book: ${chunks.length} chunks, ~${approxTokens.toLocaleString('en-US')} tokens.`);
    if (approxTokens > LARGE_BOOK_TOKENS) {
        console.warn(`[Passport] WARNING: this is a large prompt. Free tiers usually cap tokens per minute ` +
            `well below this, and the call may be refused even though the model's context window fits it.`);
    }

    const glossaryPath = state.getGlossaryPath();
    let glossary = [];
    if (fs.existsSync(glossaryPath)) {
        try { glossary = JSON.parse(fs.readFileSync(glossaryPath, 'utf-8')); }
        catch (e) { console.warn(`[Passport] Could not read the glossary: ${e.message}`); }
    }

    // --- what we can measure, measured before anything is asked ---
    const person = detectNarrativePerson(bookText);
    const candidates = characterCandidates(bookText, glossary, 25);
    console.log(`[Passport] Narrative person by pronoun counts: ${person.person || 'unclear'} ` +
        `(${Math.round(person.share * 100)}% of counted pronouns).`);
    console.log(`[Passport] ${candidates.length} character candidate(s) prepared as evidence.`);

    const targetLang = state.data.metadata?.targetLanguage || config.translation.targetLanguage;
    const prompts = getPrompts(config.translation.promptLang);
    const evidence = {
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

    const client = llmManager.getClient('book');
    const { conf } = llmManager.getBookSettings();
    console.log(`[Passport] Asking ${conf.modelName} for the point-of-view cast and dossiers...`);

    let answer;
    try {
        const response = await client.invoke([
            new HumanMessage(prompts.passport.system(targetLang)),
            new HumanMessage(prompts.passport.user(bookText, evidence)),
        ]);
        answer = extractJson(response.content || '');
    } catch (e) {
        console.error(`[Passport] The whole-book call failed: ${e.message}`);
        if (e.contentBlocked) {
            console.error('[Passport] The provider refused the text. Retrying will not help — switch the book_model provider.');
        }
        return;
    }

    // --- merge: the model's answer, then the map computed from it ---
    const passport = loadPassport(state.getPassportPath());

    // Non-fiction is the answer that changes behaviour, so it has to be stated;
    // anything unrecognized falls back to fiction, which is what the pipeline
    // did before this field existed.
    const kindRaw = String(answer?.kind || '').trim().toLowerCase();
    passport.kind = /non-?fiction|нехудож|документ|публицист/.test(kindRaw) ? 'nonfiction' : 'fiction';
    // A register is substituted into the prompt as a value: keep it a phrase.
    const registerRaw = String(answer?.register || '').trim();
    passport.register = registerRaw ? registerRaw.split(/[.;\n]/)[0].trim().slice(0, 80) : null;

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

    // The map is computed first: anchors plus a rotation prior score 99.4% on
    // chapter-aligned chunks and cost nothing. The model's quoted boundaries are
    // the fallback for what that cannot see — a book whose point of view changes
    // without any chapter heading to key off. Measured on this book with its
    // headings stripped: the deterministic layer produces an empty map, while
    // the quoted boundaries land 36 of 38 chapters with a median error of 3
    // characters (95.5% of chunks labelled correctly).
    passport.povMap = buildPovMap(chunks, castNames);
    let mapSource = 'anchors';

    if (castNames.length > 1 && !passport.povMap.length) {
        const { map, offsets, stats } = spansFromQuotes(chunks, answer?.povSpans, castNames);
        console.log(`[Passport] No anchors found — falling back to the model's quoted boundaries: ` +
            `${stats.located}/${stats.total} located` +
            `${stats.missing ? `, ${stats.missing} not in the text` : ''}` +
            `${stats.ambiguous ? `, ${stats.ambiguous} ambiguous` : ''}` +
            `${stats.outOfOrder ? `, ${stats.outOfOrder} out of order` : ''}` +
            `${stats.unknownCharacter ? `, ${stats.unknownCharacter} naming someone outside the cast` : ''}.`);

        if (map.length) {
            passport.povMap = map;
            mapSource = 'quotes';

            // These boundaries arrive after the text was already split, and they
            // land mid-chunk far more often than not (measured: 28 of 36, median
            // 847 characters from the nearest edge). A chunk straddling a change
            // of narrator gets one label for two people, which is precisely the
            // defect the map exists to prevent. Re-split with the boundaries as
            // hard break points — but only while nothing has been translated,
            // since re-splitting renumbers the chunks and would orphan the work.
            const translated = chunks.filter(c => c.translation).length;
            if (translated) {
                console.warn(`[Passport] ${translated} chunk(s) already translated, so the text is not re-split. ` +
                    `Boundaries stay buried inside chunks and those chunks carry two narrators; ` +
                    `a fresh project on the same source would be cut cleanly.`);
            } else {
                const source = chunks.map(c => c.original).join('');
                const resplit = splitTextIntoChunks(source, offsets);
                state.setChunks(resplit);
                state.save();
                console.log(`[Passport] Re-split on ${offsets.length} point-of-view boundaries: ` +
                    `${chunks.length} → ${resplit.length} chunks, none spanning a change of narrator.`);
                chunks = resplit;
                // Indices changed with the split, so the map is rebuilt against
                // the new chunks; the old one stands if that somehow yields less.
                const rebuilt = spansFromQuotes(chunks, answer?.povSpans, castNames);
                if (rebuilt.map.length) passport.povMap = rebuilt.map;
            }
        }
    }

    passport.source = { model: conf.modelName, generatedAt: new Date().toISOString(), povMapFrom: mapSource };

    savePassport(state.getPassportPath(), passport);

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
            `from ${mapSource === 'quotes' ? "the model's quoted boundaries" : 'anchors + rotation'} ` +
            `(${stats.anchors} of ${stats.segments} segments carried an anchor).`);
        if (!passport.povMap.length) {
            console.warn('[Passport] Neither anchors nor usable quoted boundaries — the map has nothing to build on. ' +
                'Chunks stay undetermined, and the translation prompt will be told to avoid gendered forms rather than guess.');
        }
    } else if (castNames.length === 1) {
        console.log(`[Passport] Single narrator (${castNames[0]}) — no map needed, the decision holds for the whole book.`);
    }

    console.log(`[Passport] Saved to ${state.getPassportPath().split(/[\\/]/).pop()}`);
    console.log('--- SYSTEM: Book passport completed ---');
}
