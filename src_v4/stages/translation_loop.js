import fs from 'fs';
import { llmManager } from '../core/llm_client.js';
import { usageTracker } from '../core/usage_tracker.js';
import { HumanMessage } from "@langchain/core/messages";
import { extractFromTags, extractTagOptional, extractCheckResult } from '../utils/parsers.js';
import { wholeWordRegex } from '../core/text_stats.js';
import { loadPassport, buildStyleBlock, isEmptyPassport } from '../core/passport.js';
import { adviceForChunk } from '../core/translation_review.js';
import config from '../config.js';
import { getPrompts } from '../prompts.js';

export async function runTranslationLoopStage(state) {
    console.log('--- SYSTEM: Starting Stage 2 (Smart Translation Loop) ---');

    const targetLang = state.data.metadata?.targetLanguage || config.translation.targetLanguage;
    const prompts = getPrompts(config.translation.promptLang);

    const chunks = state.getChunks();
    const glossaryPath = state.getGlossaryPath();
    let glossary = [];

    if (fs.existsSync(glossaryPath)) {
        glossary = JSON.parse(fs.readFileSync(glossaryPath, 'utf-8'));
        console.log(`[Stage 2] Loaded glossary with ${glossary.length} terms.`);
        const named = glossary.filter(t => t?.type === 'name' && t.gender).length;
        const noted = glossary.filter(t => String(t?.notes || '').trim()).length;
        console.log(`[Stage 2] Cheat sheet carries gender for ${named} character(s) and notes for ${noted} entr(ies).`);
    } else {
        console.warn('[Stage 2] No glossary found. Translation will proceed without it.');
    }

    // Book passport: whole-book decisions (narration person/tense, address
    // form, per-chunk narrator gender) injected into every prompt as <style>.
    // Missing or broken passport degrades to empty → prompts stay unchanged.
    const passport = loadPassport(state.getPassportPath());
    if (isEmptyPassport(passport)) {
        console.log('[Stage 2] No passport found — translating without <style> constraints (run --stage=passport to build one).');
    } else {
        const n = passport.narration || {};
        console.log(`[Stage 2] Passport loaded: narration ${n.person || '—'}/${n.tense || '—'}, ${passport.characters.length} POV character(s), ${passport.povMap.length} map span(s).`);
    }

    // Names the glossary genders two ways travel without a gender rather than
    // with a wrong one. Computed once: the glossary does not change mid-run.
    const contradicted = contradictedNames(glossary);
    if (contradicted.size) {
        console.warn(`[Stage 2] ${contradicted.size} name(s) carry contradictory genders in the glossary ` +
            `and will be sent without one — run tools/glossary_hygiene.js or open the glossary editor to settle them.`);
    }

    const client = llmManager.getClient('logic'); // Only one model for V4

    let processedCount = 0;
    const blockedChunks = []; // 1-based numbers of chunks the content filter refused

    // A content filter refuses a text, not a request: the same model refuses it
    // again, so retrying is pure waste. Another model may well accept it —
    // observed on Morphotrophic, where gemini-3.6-flash translated a chunk that
    // gemini-3.5-flash-lite would not. So a block is recorded against the model
    // that made it, and only that model skips the chunk on a rerun. Same field
    // shape as Stage 1, under its own name: extraction and translation can be
    // blocked by different models, and one field could not say so.
    const modelSignature = `${llmManager.provider}:${llmManager.getModelName()}`;

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        // Advice from the whole-book review is work outstanding on a chunk that
        // is otherwise finished, so it has to be looked at before the "already
        // done" test — which would otherwise skip every chunk the review named.
        const advice = adviceForChunk(chunk.advice);

        // Skip if already finalized (success=true) or has good score
        if (chunk.translation && chunk.translation_status === 'success' && !advice) {
            continue;
        }
        if (chunk.translation_status === 'blocked' && chunk.translation_blocked_by === modelSignature) {
            continue;
        }
        if (chunk.translation_status === 'blocked') {
            console.log(`[Stage 2] Chunk ${i + 1} was blocked by "${chunk.translation_blocked_by || 'unknown model'}" — retrying with "${modelSignature}"...`);
        }

        console.log(`[Stage 2] Processing Chunk ${i + 1}/${chunks.length}...`);

        let history = chunk.history || [];

        try {

        // 1. DRAFTING
        let currentTranslation = "";
        let currentComment = ""; // New field
        let globalContext = getLocalContextString(chunk.original, glossary, contradicted);
        // Whole-book constraints for THIS chunk (narrator + gender come from the
        // POV map; other cast members named in the chunk bring their dossiers,
        // so the block differs between chapters and scenes).
        const styleBlock = buildStyleBlock(passport, i, config.translation.promptLang, chunk.original);

        // A chunk carrying advice already has a translation somebody wants kept
        // and corrected. It goes straight to a fix with that advice as the
        // instruction: redrafting would throw away the nine tenths of the chunk
        // nobody complained about, and the reviewer that would then judge the
        // redraft approves everything anyway (median 10 across five books).
        const currentText = chunk.translation || history[history.length - 1]?.text || '';
        if (advice && currentText) {
            console.log(`   -> Fixing on ${chunk.advice.length} piece(s) of advice from the whole-book review...`);
            const fixed = await fixTranslation(client, prompts, targetLang, chunk.original,
                currentText, globalContext, advice, styleBlock);
            currentTranslation = fixed.translation;
            currentComment = fixed.comment;
            history.push({
                step: 'advice_fix',
                text: currentTranslation,
                translator_comment: currentComment,
                advice,
                timestamp: new Date().toISOString(),
            });
        } else if (history.length === 0) {
            console.log(`   -> Drafting...`);
            const draft = await draftTranslation(client, prompts, targetLang, chunk.original, globalContext, styleBlock);
            currentTranslation = draft.translation;
            currentComment = draft.comment;
            console.log(`   [DEBUG] After draft: translation length=${currentTranslation?.length || 0}, first 100 chars: "${(currentTranslation || '').substring(0, 100)}"`);
            console.log(`   [DEBUG] After draft: comment="${currentComment}"`);

            history.push({
                step: 'draft',
                text: currentTranslation,
                translator_comment: currentComment,
                timestamp: new Date().toISOString()
            });

        } else {
            // Take the last text from history
            const lastItem = history[history.length - 1];
            currentTranslation = lastItem.text;
            currentComment = lastItem.translator_comment || "";
        }

        // 2. THE LOOP
        let attempts = 0;
        const MAX_RETRIES = config.pipeline.translationMaxRetries;
        const REDRAFT_SCORE_THRESHOLD = config.pipeline.redraftScoreThreshold;
        const APPROVAL_SCORE_THRESHOLD = config.pipeline.approvalScoreThreshold;
        const MAX_REDRAFTS = config.pipeline.translationMaxRedrafts ?? 3;
        let success = false;
        // Deadlock detection. A redraft repeats the exact same draft call, so
        // when the reviewer rejects redrafts with the same complaint over and
        // over, the two prompts are in conflict — the translator will keep
        // producing the same answer and the reviewer will keep refusing it.
        // Measured on a real run: one chunk burned 9 redrafts on a complaint the
        // human proofread later proved wrong. Burning budget cannot resolve a
        // rules conflict; a human can, so mark the chunk disputed and move on.
        let redrafts = 0;
        let lastRedraftComplaint = null;
        let lastFixComplaint = null;
        let dispute = null;

        while (attempts < MAX_RETRIES && !success) {
            attempts++;
            console.log(`   -> Loop Iteration ${attempts} (Check)...`);

            console.log(`   [DEBUG] Before check: currentTranslation length=${currentTranslation?.length || 0}, first 100 chars: "${(currentTranslation || '').substring(0, 100)}"`);
            // CHECK
            const checkResult = await checkTranslation(client, prompts, targetLang, chunk.original, currentTranslation, globalContext, currentComment, styleBlock, advice);
            history.push({
                step: `check_${attempts}`,
                result: checkResult,
                text: currentTranslation,
                translator_comment: currentComment,
                timestamp: new Date().toISOString()
            });

            // DECISION
            // success criteria from index10.js: !error && !misspell && correctness && like && (score >= 9.1 if not perfect)
            // if (successfully == 0 && dataJson.data.like && dataJson.data.score >= 9.1) successfully = 1;

            const isPerfect = (checkResult.error === 0 && checkResult.misspell === 0 && checkResult.correctness === 1 && checkResult.like === 1);
            let passed = isPerfect;

            if (!passed && checkResult.like === 1 && checkResult.score >= APPROVAL_SCORE_THRESHOLD) {
                passed = true;
            }

            if (passed) {
                console.log(`   -> APPROVED (Score: ${checkResult.score})`);
                success = true;
                state.updateChunk(i, {
                    translation: currentTranslation,
                    translation_status: 'success',
                    history: history,
                    // This model got through where another was refused; leaving
                    // the old block behind would keep the chunk skipped forever.
                    ...(chunk.translation_blocked_by ? { translation_blocked_by: null } : {}),
                    // The advice has been acted on and approved. Left in place it
                    // would re-fix this chunk on every run from here on.
                    ...(advice ? { advice: null } : {})
                });
            } else {
                // Break if max retries reached to avoid wasted fix/redraft
                if (attempts >= MAX_RETRIES) {
                    console.warn(`   -> Max retries reached.`);
                    break;
                }

                // Decide: FIX (доработка) vs REDRAFT (перевод заново)
                // Fix only if checker likes the direction AND score is above threshold
                // Otherwise retranslate from scratch — no point fixing a fundamentally broken translation
                //
                // Except under advice, where a redraft is never the right repair.
                // That chunk is not a failed attempt: it was translated, reviewed,
                // approved, and then one thing in it was objected to. Measured on
                // the first real run of this path, chunk 27 of Morphotrophic
                // scored 9 with "соблюдены все стилистические и терминологические
                // требования" and was rewritten from nothing because a single word
                // came out «сухо» instead of «коротко». Correcting is what was
                // asked for; starting over answers a question nobody put.
                const shouldFix = advice
                    ? true
                    : (checkResult.like === 1 && checkResult.score >= REDRAFT_SCORE_THRESHOLD);

                if (shouldFix) {
                    // Under advice the redraft cap does not apply, so a fixer and
                    // a reviewer who disagree could trade the same objection until
                    // the retry budget runs out. The same deadlock the redraft path
                    // already recognises, and the same answer: two identical
                    // complaints mean a human should look, not that a third attempt
                    // will land.
                    if (advice && lastFixComplaint && complaintsAlike(lastFixComplaint, checkResult.comment)) {
                        dispute = { reason: checkResult.comment, kind: 'advice_not_met' };
                        console.warn(`   -> DISPUTED: the reviewer repeats the same objection after a fix — the advice ` +
                            `and the text are in conflict, a human should settle it. | "${String(checkResult.comment).slice(0, 120)}"`);
                        break;
                    }
                    lastFixComplaint = checkResult.comment;

                    // Checker likes the direction, score is acceptable → FIX (доработка)
                    console.log(`   -> REJECTED for fixing (Score: ${checkResult.score}, Errors: ${checkResult.error}) | Reason: "${checkResult.comment}". Fixing...`);

                    const fixResult = await fixTranslation(client, prompts, targetLang, chunk.original, currentTranslation, globalContext, checkResult.comment, styleBlock);
                    currentTranslation = fixResult.translation;
                    currentComment = fixResult.comment;
                    console.log(`   [DEBUG] After fix: translation length=${currentTranslation?.length || 0}, first 100 chars: "${(currentTranslation || '').substring(0, 100)}"`);
                    console.log(`   [DEBUG] After fix: comment="${currentComment}"`);

                    history.push({
                        step: `fix_${attempts}`,
                        text: currentTranslation,
                        translator_comment: currentComment,
                        timestamp: new Date().toISOString()
                    });
                } else {
                    // Checker doesn't like it at all → REDRAFT (перевод заново).
                    // But first, recognize a deadlock: the same complaint about a
                    // fresh draft means the next draft will earn it again.
                    if (lastRedraftComplaint && complaintsAlike(lastRedraftComplaint, checkResult.comment)) {
                        dispute = { reason: checkResult.comment, kind: 'repeated_complaint' };
                        console.warn(`   -> DISPUTED: reviewer repeats the same complaint about a fresh draft — translator and reviewer are in conflict, a human should decide. | "${String(checkResult.comment).slice(0, 120)}"`);
                        break;
                    }
                    if (redrafts >= MAX_REDRAFTS) {
                        dispute = { reason: checkResult.comment, kind: 'redraft_cap' };
                        console.warn(`   -> DISPUTED: ${redrafts} redrafts spent without agreement — stopping instead of burning budget.`);
                        break;
                    }
                    console.log(`   -> REJECTED for redraft (Score: ${checkResult.score}, Like: ${checkResult.like}) | Reason: "${checkResult.comment}". Retranslating from scratch...`);
                    redrafts++;
                    lastRedraftComplaint = checkResult.comment;

                    const draft = await draftTranslation(client, prompts, targetLang, chunk.original, globalContext, styleBlock);
                    currentTranslation = draft.translation;
                    currentComment = draft.comment;
                    console.log(`   [DEBUG] After redraft: translation length=${currentTranslation?.length || 0}, first 100 chars: "${(currentTranslation || '').substring(0, 100)}"`);
                    console.log(`   [DEBUG] After redraft: comment="${currentComment}"`);

                    history.push({
                        step: `redraft_${attempts}`,
                        text: currentTranslation,
                        translator_comment: currentComment,
                        timestamp: new Date().toISOString()
                    });
                }

            }
        }

        if (!success) {
            // Find best version in history
            let bestScore = -1;
            let bestText = currentTranslation; // Default to the last attempted translation

            history.forEach(h => {
                if (h.result && h.result.score > bestScore && h.text) {
                    bestScore = h.result.score;
                    bestText = h.text;
                }
            });

            console.warn(dispute
                ? `   -> Saving best effort (Score: ${bestScore}) and marking the chunk DISPUTED for human review.`
                : `   -> Failed to reach perfection. Saving best effort (Score: ${bestScore}).`);

            state.updateChunk(i, {
                translation: bestText,
                // The GUI knows this status; the dispute flag rides alongside so
                // a conflict of rules is distinguishable from a genuinely weak
                // translation.
                translation_status: 'failed_best_effort',
                ...(dispute ? { dispute } : {}),
                history: history,
                ...(chunk.translation_blocked_by ? { translation_blocked_by: null } : {})
            });
        }

        } catch (error) {
            // A content filter refuses the text, not the request, and it refuses
            // it every time. Until now one refused chunk killed the whole run:
            // measured on Morphotrophic, six consecutive runs died on chunks 11
            // and 17, and the book never got past chunk 17 of 169. Skipping costs
            // one chunk; aborting costs the book.
            //
            // Only a content block skips. A bad key, an exhausted quota or a dead
            // server fails identically on every chunk, and quietly marking all
            // 169 "blocked" would bury that under a plausible-looking report.
            if (!error.contentBlocked) throw error;

            console.warn(`   -> BLOCKED by the content filter of ${modelSignature} — skipping this chunk.`);
            console.warn(`      ${String(error.message).slice(0, 300)}`);
            state.updateChunk(i, {
                translation_status: 'blocked',
                translation_blocked_by: modelSignature,
                // Whatever was drafted before the refusal is kept. A block during
                // the review would otherwise throw away a draft already paid for,
                // and the next model resumes from it instead of buying it again.
                history: history
            });
            blockedChunks.push(i + 1);
        }

        processedCount++;
        state.save();
        console.log(`[Stage 2] Saved progress.`);
        const usageLine = usageTracker.sessionLine();
        if (usageLine) console.log(usageLine);
    }

    state.save();
    if (blockedChunks.length) {
        console.warn(`\n[Stage 2] WARNING: ${blockedChunks.length} chunk(s) were refused by the content filter of ` +
            `${modelSignature} and are left untranslated: ${blockedChunks.join(', ')}.`);
        console.warn(`[Stage 2] They are marked on the chunk map, and the exported book will be missing them. ` +
            `Switch to another provider or model in the settings — a local one has no such filter — and run Stage 2 ` +
            `again: everything already translated is kept, only the blocked chunks are picked up.`);
    }
    console.log('--- SYSTEM: Stage 2 (Translation Loop) Completed ---');
}

// --- HELPERS ---

// Substring matching turned nearly half the cheat sheet into noise: "HA" fired
// inside "charles", "M" inside "memory", "ICE" inside "noticed". wholeWordRegex
// handles that, and handles the opposite case too — in Chinese or Japanese,
// where nothing is space-separated, it falls back to a plain substring match.
const termRegexCache = new Map();

function cachedTermRegex(term) {
    let re = termRegexCache.get(term);
    if (!re) {
        re = wholeWordRegex(term, 'iu');
        termRegexCache.set(term, re);
    }
    return re;
}

// A note long enough to be a paragraph is a dossier, not a cheat-sheet entry.
// Measured on real glossaries: median note 32 characters, 90th percentile 51.
const MAX_NOTE_CHARS = 120;

/**
 * Names whose gender the glossary states two ways.
 *
 * Stage 1 files one character under several entries, and they can disagree —
 * "Detective Sergeant Smith"=m beside "Sue Smith"=f for the same woman. Passing
 * that into the prompt is worse than passing nothing: it would order masculine
 * agreement in a female narrator's chapters. The hygiene tool reports these for
 * a human to settle, but the pipeline must stay safe on a glossary nobody has
 * cleaned yet, so a contradicted name simply travels without its gender.
 */
function contradictedNames(glossary) {
    const singles = new Map();
    for (const term of glossary) {
        const name = String(term?.original || '').trim();
        if (term?.type === 'name' && name && !/\s/.test(name)) singles.set(name.toLowerCase(), term);
    }

    const contradicted = new Set();
    for (const term of glossary) {
        const name = String(term?.original || '').trim();
        if (term?.type !== 'name' || !name || !/\s/.test(name)) continue;
        for (const part of name.split(/\s+/)) {
            if (part.length <= 2) continue;
            const inner = singles.get(part.toLowerCase());
            if (inner && term.gender && inner.gender && term.gender !== inner.gender) {
                contradicted.add(name.toLowerCase());
                contradicted.add(String(inner.original).toLowerCase());
            }
        }
    }
    return contradicted;
}

const GENDER_WORD = { m: 'муж', f: 'жен', n: 'ср' };

/**
 * The cheat sheet for one chunk: every glossary entry the text mentions.
 *
 * Carries more than the translation. Gender is what Russian agreement needs for
 * any character named in the chunk ("Элейн сказала", not "сказал"), and the
 * note is what tells a translator which of two same-named people this is. Both
 * sat unused in the glossary while the prompt saw only "original -> translation".
 */
function getLocalContextString(text, glossary, contradicted = new Set()) {
    const hits = [];
    glossary.forEach(term => {
        const original = String(term?.original || '').trim();
        if (!original) return;
        if (!cachedTermRegex(original).test(text)) return;

        let line = `${original} -> ${term.translation}`;
        // Gender only for people: on a term it is the grammatical gender of the
        // translation, which the model can see for itself and which is wrong
        // often enough in the glossary to be worth leaving out.
        const gender = term.type === 'name' ? GENDER_WORD[term.gender] : null;
        if (gender && !contradicted.has(original.toLowerCase())) line += ` (${gender})`;

        const note = String(term.notes || '').trim();
        if (note) line += ` — ${note.length > MAX_NOTE_CHARS ? note.slice(0, MAX_NOTE_CHARS) + '…' : note}`;

        hits.push(line);
    });
    return hits.join('\n');
}


/**
 * Do two reviewer complaints say the same thing?
 *
 * LLM wording varies («использовал обращение на вы» vs «используется обращение
 * на Вы»), so words are lightly stemmed — lowercased, truncated to 6 chars —
 * before comparing. Overlap is measured against the shorter complaint. Applied
 * only to redraft rejections: repeated fix complaints are usually genuine
 * errors taking several passes, repeated redraft complaints mean the reviewer
 * keeps refusing what the translator keeps producing.
 */
function complaintsAlike(a, b) {
    const words = s => new Set(
        String(s).toLowerCase().match(/[\p{L}]{4,}/gu)?.map(w => w.slice(0, 6)) || []
    );
    const wa = words(a), wb = words(b);
    if (!wa.size || !wb.size) return false;
    let common = 0;
    for (const w of wa) if (wb.has(w)) common++;
    return common / Math.min(wa.size, wb.size) >= 0.4;
}

// --- LLM FUNCTIONS (Prompts from index10.js) ---

// How many times to re-ask when the answer comes back without a <translate> tag.
const MISSING_TAG_RETRIES = 2;

/**
 * Run a translate/fix call and pull the <translate> tag out of the answer.
 * A missing tag means the model ignored the output format and the response is
 * its preamble or reasoning — re-ask instead of pasting that into the book.
 * If it keeps ignoring the format, hand the raw text back so the review loop
 * can score it and redraft, as it did before.
 */
async function invokeForTranslation(client, label, messages) {
    let content = '';
    for (let attempt = 1; attempt <= MISSING_TAG_RETRIES + 1; attempt++) {
        const response = await client.invoke(messages);
        content = response.content || '';
        const translation = extractFromTags(content, 'translate');
        if (translation !== null) {
            return { translation, comment: extractTagOptional(content, 'comment') };
        }
        console.warn(`   [WARN] ${label}: answer has no <translate> tag (attempt ${attempt}/${MISSING_TAG_RETRIES + 1}).`);
    }
    console.warn(`   [WARN] ${label}: still no <translate> tag — passing the raw answer to review.`);
    return { translation: content.trim(), comment: extractTagOptional(content, 'comment') };
}

async function draftTranslation(client, prompts, targetLang, original, context, style) {
    usageTracker.setStage('translate');
    const input = prompts.draft.user(original, context, style);
    const prompt = prompts.draft.system(targetLang);

    return invokeForTranslation(client, 'draft', [
        new HumanMessage(prompt),
        new HumanMessage(input)
    ]);
}

async function checkTranslation(client, prompts, targetLang, original, translation, context, translatorComment, style, advice) {
    usageTracker.setStage('check');
    const input = prompts.check.user(context, original, translation, translatorComment, style, advice);

    const prompt = prompts.check.system(targetLang);

    const response = await client.invoke([
        new HumanMessage(prompt),
        new HumanMessage(input)
    ]);
    //console.log("check tr input=", input);
    //console.log("check tr prompt=", prompt);
    //console.log("check tr response=", response.content);

    // Normalize keys just in case
    return extractCheckResult(response.content);
}

async function fixTranslation(client, prompts, targetLang, original, badTranslation, context, comment, style) {
    usageTracker.setStage('fix');
    const input = prompts.fix.user(original, context, badTranslation, comment, style);

    const prompt = prompts.fix.system(targetLang);

    return invokeForTranslation(client, 'fix', [
        new HumanMessage(prompt),
        new HumanMessage(input)
    ]);
}
