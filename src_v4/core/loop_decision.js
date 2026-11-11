/**
 * What the translation loop does next, as a function of what the reviewer said.
 *
 * Kept apart from the loop itself (stages/translation_loop.js), which is all
 * model calls and state writes. The decisions here are the part with the
 * history — each rule below was added after a real book went wrong without it —
 * and the part that can be checked without a model: nothing in this file calls
 * one, reads a file or keeps anything between calls.
 */

/**
 * Do two reviewer complaints say the same thing?
 *
 * LLM wording varies («использовал обращение на вы» vs «используется обращение
 * на Вы»), so words are lightly stemmed — lowercased, truncated to 6 chars —
 * before comparing. Overlap is measured against the shorter complaint.
 */
export function complaintsAlike(a, b) {
    const words = s => new Set(
        String(s).toLowerCase().match(/[\p{L}]{4,}/gu)?.map(w => w.slice(0, 6)) || []
    );
    const wa = words(a), wb = words(b);
    if (!wa.size || !wb.size) return false;
    let common = 0;
    for (const w of wa) if (wb.has(w)) common++;
    return common / Math.min(wa.size, wb.size) >= 0.4;
}

/**
 * Is this verdict an approval?
 *
 * Either a clean sheet — no errors, no misspellings, correct, liked — whatever
 * the score, or a text the reviewer likes and scores at the threshold or above.
 */
export function isApproved(check, approvalThreshold) {
    const perfect = check.error === 0 && check.misspell === 0 && check.correctness === 1 && check.like === 1;
    return perfect || (check.like === 1 && check.score >= approvalThreshold);
}

/**
 * The next move after a check.
 *
 * @param {object} p
 * @param {object} p.check        the reviewer's verdict (see extractCheckResult)
 * @param {number} p.attempts     checks made so far, this one included
 * @param {boolean} p.underAdvice the chunk is being corrected on review advice
 * @param {number} p.redrafts     redrafts already spent on this chunk
 * @param {?string} p.lastFixComplaint      the complaint the last fix answered
 * @param {?string} p.lastRedraftComplaint  the complaint the last redraft answered
 * @param {object} p.limits       { maxRetries, maxRedrafts, approvalThreshold, redraftThreshold }
 * @returns {{action: 'approve'|'stop'|'fix'|'redraft'}
 *          |{action: 'dispute', kind: 'advice_not_met'|'repeated_complaint'|'redraft_cap'}}
 *   `stop` is the retry budget running out: nothing is wrong with the rules,
 *   the text is just not there yet. `dispute` is the rules in conflict — the
 *   same objection after the same repair — which more attempts cannot settle
 *   and a human can.
 */
export function nextStep({ check, attempts, underAdvice, redrafts, lastFixComplaint, lastRedraftComplaint, limits }) {
    if (isApproved(check, limits.approvalThreshold)) return { action: 'approve' };

    // No budget left for the repair to be checked, so the repair is not bought.
    if (attempts >= limits.maxRetries) return { action: 'stop' };

    // Fix only if the reviewer likes the direction and the score is above the
    // threshold; otherwise retranslate from scratch — no point fixing a
    // fundamentally broken translation.
    //
    // Except under advice, where a redraft is never the right repair. That
    // chunk is not a failed attempt: it was translated, reviewed, approved, and
    // then one thing in it was objected to. Measured on the first real run of
    // this path, chunk 27 of Morphotrophic scored 9 with "соблюдены все
    // стилистические и терминологические требования" and was rewritten from
    // nothing because a single word came out «сухо» instead of «коротко».
    // Correcting is what was asked for; starting over answers a question
    // nobody put.
    const fix = underAdvice || (check.like === 1 && check.score >= limits.redraftThreshold);

    if (fix) {
        // Under advice the redraft cap does not apply, so a fixer and a
        // reviewer who disagree could trade the same objection until the retry
        // budget runs out. Two identical complaints mean a human should look,
        // not that a third attempt will land.
        //
        // Only under advice: without it, repeated fix complaints are usually
        // genuine errors taking several passes.
        if (underAdvice && lastFixComplaint && complaintsAlike(lastFixComplaint, check.comment)) {
            return { action: 'dispute', kind: 'advice_not_met' };
        }
        return { action: 'fix' };
    }

    // A redraft repeats the exact same draft call, so when the reviewer rejects
    // redrafts with the same complaint over and over, the two prompts are in
    // conflict — the translator will keep producing the same answer and the
    // reviewer will keep refusing it. Measured on a real run: one chunk burned
    // 9 redrafts on a complaint the human proofread later proved wrong.
    if (lastRedraftComplaint && complaintsAlike(lastRedraftComplaint, check.comment)) {
        return { action: 'dispute', kind: 'repeated_complaint' };
    }
    if (redrafts >= limits.maxRedrafts) return { action: 'dispute', kind: 'redraft_cap' };
    return { action: 'redraft' };
}

/**
 * The best-scored text among the attempts, for a chunk that was never approved.
 *
 * Not the whole history when this run fixed on advice. The attempts before
 * that fix scored a text the whole-book review has since found wrong, and it
 * found it on evidence the per-chunk checker never had — the rest of the book.
 * Those scores are honest and stale: chunk 7 of Morphotrophic scored 10 before
 * the review and 9.5 after, and a scan of the whole history would have restored
 * the 10 — putting back the very sentence the review complained about, while
 * the fix stayed in the history to mark the finding handled.
 *
 * So the fix is the floor: past it lies a decision already made. The last fix,
 * not the first — a chunk can be sent back by a second review, and the round
 * before that one is just as stale.
 *
 * @param {Array<object>} history   the chunk's steps, oldest first
 * @param {boolean} underAdvice
 * @param {string} fallback  the text to keep when no attempt carries a score
 * @returns {{text: string, score: number}}  score is -1 when nothing was scored
 */
export function bestAttempt(history, underAdvice, fallback) {
    let fixedAt = -1;
    for (let k = history.length - 1; k >= 0; k--) {
        if (history[k]?.step === 'advice_fix') { fixedAt = k; break; }
    }
    const considered = underAdvice && fixedAt >= 0 ? history.slice(fixedAt) : history;

    let score = -1;
    let text = fallback;
    for (const h of considered) {
        if (h.result && h.result.score > score && h.text) {
            score = h.result.score;
            text = h.text;
        }
    }
    return { text, score };
}
