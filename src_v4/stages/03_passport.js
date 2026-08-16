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

export async function runPassportStage(state) {
    console.log('--- SYSTEM: Building book passport ---');
    usageTracker.setStage('passport');

    const chunks = state.getChunks();
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

    passport.narration = {
        person: normalizePerson(answer?.narration?.person) || person.person,
        tense: normalizeTense(answer?.narration?.tense),
        addressForm: answer?.narration?.addressForm || null,
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
    passport.povMap = buildPovMap(chunks, castNames);
    passport.source = { model: conf.modelName, generatedAt: new Date().toISOString() };

    savePassport(state.getPassportPath(), passport);

    // --- report ---
    const { person: p, tense, addressForm } = passport.narration;
    console.log(`[Passport] Narration: ${p || '—'}, ${tense || '—'}${addressForm ? `, addressing the reader as "${addressForm}"` : ''}.`);
    for (const c of passport.characters) {
        console.log(`[Passport]   ${c.name} (${c.gender || 'gender unknown'}): ${c.dossier.slice(0, 90)}`);
    }

    if (castNames.length > 1) {
        const stats = describePovMap(chunks, castNames);
        const covered = passport.povMap.reduce((n, s) => n + (s.toChunk - s.fromChunk + 1), 0);
        console.log(`[Passport] Point-of-view map: ${passport.povMap.length} span(s) over ${covered}/${chunks.length} chunks ` +
            `(${stats.anchors} of ${stats.segments} segments carried an anchor).`);
        if (!passport.povMap.length) {
            console.warn('[Passport] No character was ever addressed by name in dialogue, so the map has nothing to sync to. ' +
                'Chunks stay undetermined, and the translation prompt will be told to avoid gendered forms rather than guess.');
        }
    } else if (castNames.length === 1) {
        console.log(`[Passport] Single narrator (${castNames[0]}) — no map needed, the decision holds for the whole book.`);
    }

    console.log(`[Passport] Saved to ${state.getPassportPath().split(/[\\/]/).pop()}`);
    console.log('--- SYSTEM: Book passport completed ---');
}
