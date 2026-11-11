import fs from 'fs';
import { llmManager } from '../core/llm_client.js';
import { usageTracker } from '../core/usage_tracker.js';
import { HumanMessage } from "@langchain/core/messages";
import { extractFromTags, extractTagOptional, extractCheckResult } from '../utils/parsers.js';
import { resolveLinks } from '../core/glossary_links.js';
import { cheatSheet, contradictedNames } from '../core/cheat_sheet.js';
import { nextStep, bestAttempt } from '../core/loop_decision.js';
import { countTokens } from '../core/tokenizer.js';
import { loadPassport, buildStyleBlock, isEmptyPassport } from '../core/passport.js';
import { adviceForChunk } from '../core/translation_review.js';
import config from '../config.js';
import { getPrompts } from '../prompts.js';

export async function runTranslationLoopStage(state) {
    console.log('--- SYSTEM: Starting the translation (smart loop) ---');

    const targetLang = state.data.metadata?.targetLanguage || config.translation.targetLanguage;
    const prompts = getPrompts(config.translation.promptLang);

    const chunks = state.getChunks();
    const glossaryPath = state.getGlossaryPath();
    let glossary = [];

    if (fs.existsSync(glossaryPath)) {
        glossary = JSON.parse(fs.readFileSync(glossaryPath, 'utf-8'));
        console.log(`[Translation] Loaded glossary with ${glossary.length} terms.`);
        const named = glossary.filter(t => t?.type === 'name' && t.gender).length;
        const noted = glossary.filter(t => String(t?.notes || '').trim()).length;
        console.log(`[Translation] Cheat sheet carries gender for ${named} character(s) and notes for ${noted} entr(ies).`);
    } else {
        console.warn('[Translation] No glossary found. Translation will proceed without it.');
    }

    // Book passport: whole-book decisions (narration person/tense, address
    // form, per-chunk narrator gender) injected into every prompt as <style>.
    // Missing or broken passport degrades to empty → prompts stay unchanged.
    const passport = loadPassport(state.getPassportPath());
    if (isEmptyPassport(passport)) {
        console.log('[Translation] No passport found — translating without <style> constraints (run --stage=passport to build one).');
    } else {
        const n = passport.narration || {};
        console.log(`[Translation] Passport loaded: narration ${n.person || '—'}/${n.tense || '—'}, ${passport.characters.length} POV character(s), ${passport.povMap.length} map span(s).`);
    }

    // Clones (a note reading "= Maria Johnson") speak through their prime —
    // see core/glossary_links.js. A link that does not resolve leaves its entry
    // standing alone, which is how it behaved before links existed.
    const links = resolveLinks(glossary);
    if (links.broken.length) {
        console.warn(`[Translation] ${links.broken.length} glossary link(s) lead nowhere and are ignored: ` +
            links.broken.slice(0, 5).map(b => `${glossary[b.index].original} = ${b.target}`).join(', ') + '.');
    }

    // Names the glossary genders two ways travel without a gender rather than
    // with a wrong one. Computed once: the glossary does not change mid-run.
    const contradicted = contradictedNames(glossary, links.prime);
    if (contradicted.size) {
        console.warn(`[Translation] ${contradicted.size} name(s) carry contradictory genders in the glossary ` +
            `and will be sent without one — run tools/glossary_hygiene.js or open the glossary editor to settle them.`);
    }

    const client = llmManager.getClient('logic'); // Only one model for V4

    let processedCount = 0;
    const blockedChunks = []; // 1-based numbers of chunks the content filter refused
    const keptChunks = [];    // refused too, but they keep the translation they had
    const exhaustedChunks = []; // no answer twice: left for the next run
    // Several in a row are no longer chance: a server whose context is too
    // small for the prompt fails every chunk alike, and skipping them all
    // would bury that under a long list.
    const MAX_EXHAUSTED_IN_A_ROW = 3;
    let exhaustedInARow = 0;

    // A content filter refuses a text, not a request: the same model refuses it
    // again, so retrying is pure waste. Another model may well accept it —
    // observed on Morphotrophic, where gemini-3.6-flash translated a chunk that
    // gemini-3.5-flash-lite would not. So a block is recorded against the model
    // that made it, and only that model skips the chunk on a rerun. Same field
    // shape as extraction, under its own name: extraction and translation can be
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
        // Whatever the status. A refusal is recorded without touching a
        // translation the chunk already has (see the catch below), so a chunk
        // can be "success" with advice waiting and a model that will not do it.
        if (chunk.translation_blocked_by === modelSignature) {
            continue;
        }
        if (chunk.translation_blocked_by) {
            console.log(`[Translation] Chunk ${i + 1} was blocked by "${chunk.translation_blocked_by}" — retrying with "${modelSignature}"...`);
        } else if (chunk.translation_status === 'blocked') {
            console.log(`[Translation] Chunk ${i + 1} was blocked by "unknown model" — retrying with "${modelSignature}"...`);
        }

        console.log(`[Translation] Processing Chunk ${i + 1}/${chunks.length}...`);

        // A copy, so that a run which ends in a refusal can be left out of the
        // record — see the catch below.
        const history = [...(chunk.history || [])];
        let exhausted = false;

        try {
            await translateChunk({
                state, index: i, history, advice, client, prompts, targetLang,
                // Whole-book constraints for THIS chunk (narrator + gender come
                // from the POV map; other cast members named in the chunk bring
                // their dossiers, so the block differs between chapters and scenes).
                style: buildStyleBlock(passport, i, config.translation.promptLang, chunk.original),
                context: cheatSheet(chunk.original, glossary, contradicted, links.prime),
            });
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
            if (error.outputExhausted) {
                // The model reasoned until the limit, and did so twice (see
                // invokeRetryingRunaway). That is chance, not the text — unlike a
                // filter's refusal nothing is recorded against the model, and the
                // next run tries the chunk again. Until this, one such answer
                // ended the run: twice in the first 13 chunks of Crystal Society,
                // each after 18 minutes of reasoning.
                exhausted = true;
                exhaustedInARow++;
                exhaustedChunks.push(i + 1);
                console.warn(`   -> No answer twice — the model spent its whole output reasoning. ` +
                    `Chunk ${i + 1} is left for the next run.`);
                console.warn(`      ${String(error.message).slice(0, 300)}`);
                // A draft already paid for is kept, and the next run resumes from
                // it. Not for a chunk being reworked: its steps would include an
                // advice_fix that never reached the text.
                if (!chunk.translation) state.updateChunk(i, { history });
                if (exhaustedInARow >= MAX_EXHAUSTED_IN_A_ROW) {
                    state.save();
                    throw new Error(`${exhaustedInARow} chunks in a row got no answer (${exhaustedChunks.slice(-exhaustedInARow).join(', ')}) — ` +
                        `that is no longer chance. The prompt may not fit the model's limit. Last error: ${error.message}`);
                }
            } else if (!error.contentBlocked) {
                throw error;
            } else {
                console.warn(`   -> BLOCKED by the content filter of ${modelSignature} — skipping this chunk.`);
                console.warn(`      ${String(error.message).slice(0, 300)}`);
                if (chunk.translation) {
                    // The chunk already has a translation — approved, or the best
                    // effort of an earlier run — and a refusal to rework it says
                    // nothing against it. This used to mark it "blocked", so an
                    // approved chunk refused while acting on review advice showed on
                    // the map as untranslated. Only the refusal is recorded: this
                    // model skips the chunk from now on, and queued advice waits for
                    // another.
                    //
                    // This run's steps are left out. None was approved, and an
                    // advice_fix among them would mark the review's findings as dealt
                    // with by a fix that never reached the text.
                    state.updateChunk(i, { translation_blocked_by: modelSignature });
                    keptChunks.push(i + 1);
                } else {
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
            }
        }
        if (!exhausted) exhaustedInARow = 0;

        processedCount++;
        state.save();
        console.log(`[Translation] Saved progress.`);
        const usageLine = usageTracker.sessionLine();
        if (usageLine) console.log(usageLine);
    }

    state.save();
    if (blockedChunks.length) {
        console.warn(`\n[Translation] WARNING: ${blockedChunks.length} chunk(s) were refused by the content filter of ` +
            `${modelSignature} and are left untranslated: ${blockedChunks.join(', ')}.`);
        console.warn(`[Translation] They are marked on the chunk map, and the exported book will be missing them. ` +
            `Switch to another provider or model in the settings — a local one has no such filter — and run the translation ` +
            `again: everything already translated is kept, only the blocked chunks are picked up.`);
    }
    if (keptChunks.length) {
        console.warn(`\n[Translation] ${keptChunks.length} already translated chunk(s) were refused by the content filter of ` +
            `${modelSignature} while being reworked: ${keptChunks.join(', ')}. They keep the translation they had, and ` +
            `any review advice on them stays queued — another model will pick it up; this one skips them from now on.`);
    }
    if (exhaustedChunks.length) {
        console.warn(`\n[Translation] ${exhaustedChunks.length} chunk(s) got no answer twice — the model spent its whole ` +
            `output reasoning: ${exhaustedChunks.join(', ')}. They are left as they were; run the translation again to ` +
            `pick them up.`);
    }
    console.log('--- SYSTEM: Translation completed ---');
}

/**
 * Translate one chunk: get a starting text, then check and repair it until the
 * reviewer approves, the budget runs out or the two fall into a dispute.
 *
 * Writes the outcome onto the chunk. `history` is the caller's working copy of
 * the chunk's steps and is appended to as the work goes, so that when a call
 * throws the caller still holds everything done up to that point and decides
 * how much of it to keep. What to do after each check is decided in
 * core/loop_decision.js.
 */
async function translateChunk({ state, index, history, advice, client, prompts, targetLang, style, context }) {
    const chunk = state.getChunks()[index];
    const original = chunk.original;
    const underAdvice = !!advice;
    const stamp = () => new Date().toISOString();

    // 1. THE STARTING TEXT
    let translation = '';
    let comment = '';

    // A chunk carrying advice already has a translation somebody wants kept
    // and corrected. It goes straight to a fix with that advice as the
    // instruction: redrafting would throw away the nine tenths of the chunk
    // nobody complained about, and the reviewer that would then judge the
    // redraft approves everything anyway (median 10 across five books).
    const currentText = chunk.translation || history[history.length - 1]?.text || '';
    if (advice && currentText) {
        console.log(`   -> Fixing on ${chunk.advice.length} piece(s) of advice from the whole-book review...`);
        ({ translation, comment } = await fixTranslation(client, prompts, targetLang, original,
            currentText, context, advice, style));
        history.push({
            step: 'advice_fix',
            text: translation,
            translator_comment: comment,
            advice,
            // Which findings this fix was for. A finding leaves the review
            // list when the text it quoted is gone, and that is not the same
            // as being dealt with: a typography fix changes the punctuation
            // around the quoted words and leaves the words alone, so the
            // finding came back looking undecided after being done. The keys
            // say what was acted on regardless of what the text now looks like.
            keys: (chunk.advice || []).map(a => a.key).filter(Boolean),
            timestamp: stamp(),
        });
    } else if (history.length === 0) {
        console.log(`   -> Drafting...`);
        ({ translation, comment } = await draftTranslation(client, prompts, targetLang, original, context, style));
        history.push({ step: 'draft', text: translation, translator_comment: comment, timestamp: stamp() });
    } else {
        // An earlier run stopped partway: resume from the last text it reached.
        const last = history[history.length - 1];
        translation = last.text;
        comment = last.translator_comment || '';
    }

    // 2. CHECK AND REPAIR
    const limits = {
        maxRetries: config.pipeline.translationMaxRetries,
        maxRedrafts: config.pipeline.translationMaxRedrafts ?? 3,
        approvalThreshold: config.pipeline.approvalScoreThreshold,
        redraftThreshold: config.pipeline.redraftScoreThreshold,
    };
    let attempts = 0;
    let redrafts = 0;
    let lastFixComplaint = null;
    let lastRedraftComplaint = null;
    let dispute = null;

    while (attempts < limits.maxRetries) {
        attempts++;
        console.log(`   -> Loop Iteration ${attempts} (Check)...`);

        const check = await checkTranslation(client, prompts, targetLang, original, translation, context, comment, style, advice);
        history.push({
            step: `check_${attempts}`,
            result: check,
            text: translation,
            translator_comment: comment,
            timestamp: stamp(),
        });

        const step = nextStep({ check, attempts, underAdvice, redrafts, lastFixComplaint, lastRedraftComplaint, limits });

        if (step.action === 'approve') {
            console.log(`   -> APPROVED (Score: ${check.score})`);
            state.updateChunk(index, {
                translation,
                // Counted here, where one more tokenisation of four thousand
                // characters is nothing beside the model call that just
                // happened. Counted later, for the whole book at once, it is
                // nine seconds — and the question it answers ("does the
                // whole-book review fit?") is asked on a click.
                translationTokens: countTokens(translation),
                translation_status: 'success',
                history,
                // This model got through where another was refused; leaving
                // the old block behind would keep the chunk skipped forever.
                ...(chunk.translation_blocked_by ? { translation_blocked_by: null } : {}),
                // The advice has been acted on and approved. Left in place it
                // would re-fix this chunk on every run from here on.
                ...(advice ? { advice: null } : {}),
                // A dispute is a standing request for a human to settle
                // something, and this chunk has just been settled without
                // one. Over five or ten rounds of fixing, a chunk that
                // deadlocked once and agreed later would keep the mark for
                // the rest of the book's life — the map would show a quarrel
                // that ended rounds ago, and the marks that mean something
                // would be read past.
                ...(chunk.dispute ? { dispute: null } : {}),
            });
            return;
        }

        if (step.action === 'stop') {
            console.warn(`   -> Max retries reached.`);
            break;
        }

        if (step.action === 'dispute') {
            dispute = { reason: check.comment, kind: step.kind };
            const said = `"${String(check.comment).slice(0, 120)}"`;
            if (step.kind === 'advice_not_met') {
                console.warn(`   -> DISPUTED: the reviewer repeats the same objection after a fix — the advice ` +
                    `and the text are in conflict, a human should settle it. | ${said}`);
            } else if (step.kind === 'repeated_complaint') {
                console.warn(`   -> DISPUTED: reviewer repeats the same complaint about a fresh draft — translator and reviewer are in conflict, a human should decide. | ${said}`);
            } else {
                console.warn(`   -> DISPUTED: ${redrafts} redrafts spent without agreement — stopping instead of burning budget.`);
            }
            break;
        }

        if (step.action === 'fix') {
            lastFixComplaint = check.comment;
            console.log(`   -> REJECTED for fixing (Score: ${check.score}, Errors: ${check.error}) | Reason: "${check.comment}". Fixing...`);
            // The advice travels with every attempt. On the first one the
            // comment already was the advice; from here the comment is
            // the reviewer's objection, and without the advice beside it
            // the fixer would be working from a paraphrase.
            ({ translation, comment } = await fixTranslation(client, prompts, targetLang, original, translation, context, check.comment, style, advice));
            history.push({ step: `fix_${attempts}`, text: translation, translator_comment: comment, timestamp: stamp() });
        } else {
            redrafts++;
            lastRedraftComplaint = check.comment;
            console.log(`   -> REJECTED for redraft (Score: ${check.score}, Like: ${check.like}) | Reason: "${check.comment}". Retranslating from scratch...`);
            ({ translation, comment } = await draftTranslation(client, prompts, targetLang, original, context, style));
            history.push({ step: `redraft_${attempts}`, text: translation, translator_comment: comment, timestamp: stamp() });
        }
    }

    // 3. NEVER APPROVED: keep the best of what there is.
    const best = bestAttempt(history, underAdvice, translation);
    console.warn(dispute
        ? `   -> Saving best effort (Score: ${best.score}) and marking the chunk DISPUTED for human review.`
        : `   -> Failed to reach perfection. Saving best effort (Score: ${best.score}).`);

    state.updateChunk(index, {
        translation: best.text,
        translationTokens: countTokens(best.text),
        // The GUI knows this status; the dispute flag rides alongside so
        // a conflict of rules is distinguishable from a genuinely weak
        // translation.
        translation_status: 'failed_best_effort',
        // This run's verdict, not the last one that had a quarrel. A
        // disputed chunk is picked up by every run until approved, and
        // a run that fails without deadlocking says the text is weak,
        // not that the rules conflict — keeping the old mark, with its
        // old reason, would claim a conflict this run did not find.
        dispute: dispute || null,
        history,
        ...(chunk.translation_blocked_by ? { translation_blocked_by: null } : {}),
    });
}

// --- MODEL CALLS ---

/**
 * One call, asked again once if the model reasoned until the limit and wrote
 * nothing. Sampling makes that a matter of chance — the next attempt at the
 * same prompt usually finishes — so the second failure is the one that counts.
 */
async function invokeRetryingRunaway(client, label, messages) {
    try {
        return await client.invoke(messages);
    } catch (error) {
        if (!error.outputExhausted) throw error;
        console.warn(`   [WARN] ${label}: no answer — the model spent its whole output reasoning. Asking once more...`);
        return client.invoke(messages);
    }
}

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
        const response = await invokeRetryingRunaway(client, label, messages);
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

    const response = await invokeRetryingRunaway(client, 'check', [
        new HumanMessage(prompt),
        new HumanMessage(input)
    ]);
    return extractCheckResult(response.content);
}

async function fixTranslation(client, prompts, targetLang, original, badTranslation, context, comment, style, advice) {
    usageTracker.setStage('fix');
    const input = prompts.fix.user(original, context, badTranslation, comment, style, advice);

    const prompt = prompts.fix.system(targetLang);

    return invokeForTranslation(client, 'fix', [
        new HumanMessage(prompt),
        new HumanMessage(input)
    ]);
}
