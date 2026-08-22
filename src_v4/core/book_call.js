/**
 * Whole-book calls that a person can carry by hand.
 *
 * Every pass that reads a book in one go runs into the same wall: not the
 * model's context window but the provider's per-minute allowance over input.
 * Measured on gemini-3.7-flash's free tier, 167,852 tokens went through and
 * 195,000 was refused four times over eight minutes. The translation review of
 * Morphotrophic needs 195,472 and simply cannot be made by API on that tier.
 *
 * A web console is a different quota surface with a far larger window, so the
 * prompt can be carried there by hand and the answer carried back. That is not
 * only a way around a limit: bilingually the same review comes to 351,548
 * tokens, which no free tier will take and a million-token window will, so the
 * manual route can compare meaning against the original where the automatic one
 * can only judge the translation on its own.
 *
 * Two rules make the manual route safe to have.
 *
 * The answer goes through the identical contract — same parser, same
 * verification, same file. A hand-carried answer that skipped verification would
 * be the hole every quoted-evidence rule in this pipeline exists to prevent, and
 * it would be the widest one, because it is the route taken exactly when the
 * text is largest and hardest to check by eye.
 *
 * And the prompt carries a fingerprint of what it was built from. Between
 * copying a prompt and pasting an answer a person can fix three chunks, and then
 * the quotes no longer locate. Verification would drop them as invented, which
 * reads as a lying model rather than a moved text. The fingerprint tells the two
 * apart.
 */

import crypto from 'crypto';

/** A short, stable name for the exact text a prompt was built from. */
export function fingerprint(...parts) {
    const hash = crypto.createHash('sha1');
    for (const part of parts) hash.update(String(part ?? ''), 'utf8');
    return hash.digest('hex').slice(0, 12);
}

/**
 * Does this answer belong to this text?
 *
 * @returns {string|null} a reason to refuse, or null when it matches. An answer
 *   with no fingerprint at all is accepted: it may have been carried from a
 *   prompt built before this existed, and refusing it would be pedantry with a
 *   real cost — the person has already spent the call.
 */
export function fingerprintMismatch(expected, got) {
    if (!got || !expected || got === expected) return null;
    return `This answer was made from a different version of the text (${got} against ${expected} now). ` +
        `Something changed between building the prompt and pasting the answer, and quotes taken from the old ` +
        `version will not be found in the new one. Rebuild the prompt and ask again.`;
}
