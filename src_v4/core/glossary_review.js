/**
 * Reviewing the glossary against the book it belongs to.
 *
 * The glossary is built by consolidation in batches of thirty terms, and a batch sees
 * only its own terms plus 200 characters of context — never the book, never the
 * rest of the glossary. Measured on Halting State, that produces exactly the
 * defects you would predict: six separate entries each describing themselves as
 * "главный герой", one person split across "Mr. Reed" and "Jack Reed" with two
 * different dossiers, a sergeant called Sue in one entry and Liz in the next,
 * and a forensic accountant whose note reads «работает с книгами» — a literal
 * reading of "does the books". Those notes now go into the translation cheat
 * sheet, so a blind guess is repeated on every chunk that mentions the name.
 *
 * This module supplies the two halves that surround the one call which can fix
 * that: the evidence the model is given, and the contract every answer must pass
 * before it is allowed anywhere near the glossary.
 *
 * The contract exists because the model cannot be taken at its word. The
 * reviewer in this pipeline has been observed inventing a quote to justify a
 * complaint («was getting» rewritten as «is getting»), and a book model asked
 * about a well-known novel will happily answer from memory instead of reading.
 * Requiring a verbatim quote for every finding catches both: memory misquotes,
 * and reading does not.
 */

import { entryRegex } from './text_stats.js';
import { locateQuote } from './quoted_spans.js';
import { resolveLinks, fullerForm } from './glossary_links.js';

/** Actions a finding may propose. Nothing is ever applied automatically. */
const ACTIONS = new Set(['edit', 'add', 'merge', 'remove', 'link']);

function normalizeGender(value) {
    const s = String(value || '').trim().toLowerCase();
    if (['m', 'male', 'м', 'муж'].includes(s)) return 'm';
    if (['f', 'female', 'ж', 'жен'].includes(s)) return 'f';
    if (['n', 'neuter', 'с', 'ср'].includes(s)) return 'n';
    return null;
}

/**
 * Per-entry facts, counted rather than asked for.
 *
 * `occurrences` tells the model which entries are real, counted the way the
 * cheat sheet finds them (entryRegex). `exactCase` separates a proper noun from
 * the common word it collides with, for the entries matched in any case — terms;
 * a name is matched with its case, so the collision cannot happen to it.
 * Measured on Halting State: "NICE" (an organisation) fires 20 times of which 1
 * is the organisation, "M" fires 185 times of which 178 are the "m" in "I'm",
 * "Hell" fires 52 times of which 45 are the swear word. No amount of reading
 * tells the model that; counting does.
 */
export function glossaryEvidence(glossary, bookText) {
    return glossary.map(term => {
        const original = String(term.original || '').trim();
        const all = original ? (bookText.match(entryRegex({ original, type: term.type }, true)) || []) : [];
        const exact = all.filter(m => m === original).length;
        const row = {
            original,
            translation: String(term.translation || ''),
            type: term.type || undefined,
            gender: term.gender || undefined,
            notes: String(term.notes || '').slice(0, 200) || undefined,
            occurrences: all.length,
        };
        // Only worth the tokens when it says something: an entry that always
        // appears in its own case has nothing to report.
        if (term.type !== 'name' && all.length && exact !== all.length) row.exactCase = exact;
        return row;
    });
}

/**
 * Would deleting `entry` in favour of `survivor` leave text uncovered?
 *
 * Both are glossary entries, matched the way the cheat sheet matches them — a
 * name with its case — and the question is whether the survivor reaches
 * everywhere the doomed entry does.
 */
function losesCoverage(entry, survivor, bookText) {
    const text = String(bookText || '');
    if (!text) return false;
    const doomed = entryRegex(entry, true);
    const kept = entryRegex(survivor, true);
    const reach = String(survivor.original || '').length;
    let match;
    while ((match = doomed.exec(text)) !== null) {
        // Around the hit, wide enough for the survivor to be a longer form of it.
        const from = Math.max(0, match.index - reach);
        const window = text.slice(from, match.index + match[0].length + reach);
        if (!kept.test(window)) return true;
        kept.lastIndex = 0;
        if (match.index === doomed.lastIndex) doomed.lastIndex++;
    }
    return false;
}

/** Are a and b names, and forms of one name rather than one spelling twice? */
function isNameForm(glossary, a, b) {
    return glossary[a]?.type === 'name' && glossary[b]?.type === 'name'
        && fullerForm(glossary[a].original, glossary[b].original) !== null;
}

/**
 * The link two entries ask for: `a` becomes a clone of `b`.
 *
 * The direction is the model's, not the length of the names. "The fuller form
 * speaks for the person" was tried and is wrong exactly where it matters: on
 * Crystal Society the review said "Old Growth" — a former version of Growth —
 * duplicates "Growth", the character with 121 mentions and the real dossier,
 * and by length that made the main character a clone of its own past. Which
 * entry is the person's is a judgement about the book; the model made it, and
 * the person can still switch the prime on the group's card.
 *
 * A prime that is itself a clone is followed to the entry it speaks through,
 * and an entry that other forms already speak through is not made a clone:
 * that would make a chain.
 *
 * @returns {{clone: number, head: number} | {reason: 'badLink'|'linkedForms'}}
 */
function linkBetween(glossary, prime, a, b) {
    if (glossary[a]?.type !== 'name' || glossary[b]?.type !== 'name') return { reason: 'badLink' };
    const clone = a;
    const head = prime[b] ?? b;
    if (clone === head) return { reason: 'badLink' };
    // Linked to anyone already: the person has answered. A form that could
    // belong to two people ("Growth" beside Old Growth and New Growth) gets a
    // proposal for each, and taking one must retire the other rather than
    // offer to move the link.
    if (prime[clone] != null) return { reason: 'linkedForms' };
    if (prime.includes(clone)) return { reason: 'badLink' };
    return { clone, head };
}

/** Are entries a and b linked forms of one person — prime and clone, or two clones? */
function linked(prime, a, b) {
    const root = i => prime[i] ?? i;
    return root(a) === root(b) && (prime[a] != null || prime[b] != null);
}

/**
 * Check every finding before it is shown to anyone.
 *
 * A finding survives only if it names an entry that exists, carries a quote that
 * is actually in the book, and proposes something that differs from what is
 * already there. Anything else is dropped — a partly invented answer degrades to
 * fewer findings rather than to wrong ones.
 *
 * Dropped findings are kept, with the check they failed, rather than merely
 * counted. Whether a model that misquotes is wrong about everything else, or
 * merely sloppy about attribution, is a question only accumulated runs can
 * answer, and the counts alone cannot be re-read later. They are returned
 * separately from the verified ones and travel in their own field, so nothing
 * unverified can reach the editor by accident.
 *
 * @param {Array} raw            the model's findings, as parsed
 * @param {Array} glossary       the glossary they refer to
 * @param {string} bookText      the joined source text
 * @returns {{findings: Array, rejected: object, rejectedFindings: Array}}
 */
export function verifyFindings(raw, glossary, bookText) {
    const rejected = {
        malformed: 0,        // not an object, or an action we do not implement
        unknownEntry: 0,     // names a glossary entry that is not there
        badQuote: 0,         // the quote is not in the book
        absentOriginal: 0,   // proposes a surface form the book never uses
        unknownTarget: 0,    // merge into an entry that does not exist
        emptyFix: 0,         // nothing actually changes
        lossyMerge: 0,       // merging away an entry the survivor does not match
        linkedForms: 0,      // merging or linking forms already linked
        badLink: 0,          // a link that cannot be made: not names, or it would chain
    };
    const rejectedFindings = [];
    // Kept verbatim except for length: what the model actually wrote is the
    // evidence, so trimming it to a normalized shape would defeat the purpose.
    const drop = (reason, item) => {
        rejected[reason]++;
        rejectedFindings.push({
            reason,
            action: String(item?.action || '').slice(0, 20),
            entry: String(item?.entry || '').slice(0, 120),
            issue: String(item?.issue || '').slice(0, 40),
            problem: String(item?.problem || '').slice(0, 300),
            quote: String(item?.quote || '').slice(0, 600),
            fix: item?.fix && typeof item.fix === 'object' ? item.fix : undefined,
            mergeInto: item?.mergeInto ? String(item.mergeInto).slice(0, 120) : undefined,
            linkTo: item?.linkTo ? String(item.linkTo).slice(0, 120) : undefined,
        });
    };

    if (!Array.isArray(raw)) return { findings: [], rejected, rejectedFindings };

    const byOriginal = new Map();
    glossary.forEach((term, index) => {
        const key = String(term.original || '').trim().toLowerCase();
        if (key && !byOriginal.has(key)) byOriginal.set(key, { term, index });
    });

    const { prime } = resolveLinks(glossary);

    const findings = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') { drop('malformed', item); continue; }

        const action = String(item.action || 'edit').trim().toLowerCase();
        if (!ACTIONS.has(action)) { drop('malformed', item); continue; }

        const entryKey = String(item.entry || '').trim().toLowerCase();
        const target = entryKey ? byOriginal.get(entryKey) : null;
        if (action !== 'add' && !target) { drop('unknownEntry', item); continue; }

        // The quote is the whole point of the contract, so it is checked before
        // anything else is considered.
        if (locateQuote(bookText, item.quote).occurrences === 0) { drop('badQuote', item); continue; }

        const finding = {
            action,
            entry: target ? target.term.original : String(item.entry || '').trim(),
            index: target ? target.index : null,
            issue: String(item.issue || '').trim().slice(0, 40) || 'other',
            problem: String(item.problem || '').trim().slice(0, 300),
            quote: String(item.quote || '').trim(),
        };

        if (action === 'link' || action === 'merge') {
            const intoKey = String((action === 'link' ? item.linkTo : item.mergeInto) || '').trim().toLowerCase();
            const into = byOriginal.get(intoKey);
            if (!into || into.index === target.index) { drop('unknownTarget', item); continue; }
            // Already settled: the person linked the two forms, which keeps both
            // spellings findable and gives them one dossier — what a merge was
            // after, minus the lost spelling.
            if (linked(prime, target.index, into.index)) { drop('linkedForms', item); continue; }

            // Forms of one name are linked, whatever the model called it. A merge
            // of "Maria Johnson" into "Johnson" passes the coverage test below —
            // the surname is inside the full name — and deletes the entry with
            // the dossier; measured on Crystal Society, 24 of the review's 25
            // accepted merges were of this kind (8 of 24 on Morphotrophic). Recast here, the finding keeps
            // both spellings and asks for what the model actually meant.
            if (action === 'link' || isNameForm(glossary, target.index, into.index)) {
                const link = linkBetween(glossary, prime, target.index, into.index);
                if (link.reason) { drop(link.reason, item); continue; }
                finding.action = 'link';
                finding.entry = glossary[link.clone].original;
                finding.index = link.clone;
                finding.linkTo = glossary[link.head].original;
                if (action === 'merge') finding.recast = 'merge';
                findings.push(finding);
                continue;
            }
            // A merge deletes an entry, and the cheat sheet matches entries as
            // whole words. "Flourisher" therefore does not match "Flourishers",
            // so merging the plural away leaves every passage that only uses the
            // plural with no note at all — measured on Morphotrophic, 4 chunks for
            // Flourishers and 72 for cytes, out of 169.
            //
            // The model reasons as a lexicographer, where listing a word twice is
            // untidy, and it is right about tidiness and wrong about consequences.
            // The prompt now tells it how entries are matched — before, it had no
            // way to know, and 23 merges across four books were dropped here — but
            // being told is not the same as complying. What it proposes is
            // checkable, so it is still checked. The article case passes the same test and survives it —
            // "exchange" does match inside "the exchange", so deleting the longer
            // entry costs nothing.
            if (losesCoverage(target.term, into.term, bookText)) {
                drop('lossyMerge', item); continue;
            }
            finding.mergeInto = into.term.original;
            findings.push(finding);
            continue;
        }

        if (action === 'remove') {
            findings.push(finding);
            continue;
        }

        // --- edit and add both carry a partial entry ---
        const fix = {};
        const proposed = item.fix || {};

        const newOriginal = String(proposed.original || '').trim();
        if (newOriginal) {
            // A surface form the book never uses would sit in the glossary
            // firing on nothing — which is the defect the hygiene pass exists to
            // remove, not one to introduce.
            const newType = String(proposed.type || target?.term.type || '').trim().toLowerCase();
            if (!entryRegex({ original: newOriginal, type: newType }).test(bookText)) { drop('absentOriginal', item); continue; }
            fix.original = newOriginal;
        } else if (action === 'add') {
            drop('malformed', item); continue;
        }

        const translation = String(proposed.translation || '').trim();
        if (translation) fix.translation = translation;
        else if (action === 'add') { drop('malformed', item); continue; }

        const gender = normalizeGender(proposed.gender);
        if (gender) fix.gender = gender;
        const type = String(proposed.type || '').trim().toLowerCase();
        if (type === 'name' || type === 'term') fix.type = type;
        const notes = String(proposed.notes || '').trim();
        if (notes) fix.notes = notes.slice(0, 300);

        // A finding that proposes the values already stored is noise in the
        // editor: the row would be marked, and clicking it would change nothing.
        if (action === 'edit') {
            const current = target.term;
            const changes = Object.entries(fix).filter(([field, value]) =>
                String(current[field] || '').trim() !== String(value).trim());
            if (!changes.length) { drop('emptyFix', item); continue; }
            finding.fix = Object.fromEntries(changes);

            // A clone's gender and note are its prime's — the clone's own note
            // is the link, and writing a dossier over it would cut the link.
            // So that part of the proposal is addressed to the prime.
            const head = prime[target.index];
            if (head != null) {
                const moved = Object.entries(finding.fix).filter(([field, value]) =>
                    (field === 'notes' || field === 'gender')
                    && String(glossary[head][field] || '').trim() !== String(value).trim());
                for (const field of ['notes', 'gender']) delete finding.fix[field];
                if (moved.length) {
                    findings.push({ ...finding, entry: glossary[head].original, index: head, fix: Object.fromEntries(moved) });
                }
                if (!Object.keys(finding.fix).length) continue;
            }
        } else {
            if (byOriginal.has(fix.original.toLowerCase())) { drop('emptyFix', item); continue; }
            finding.fix = fix;
        }

        findings.push(finding);
    }

    return { findings, rejected, rejectedFindings };
}

/**
 * A merge recorded before merges of name forms became links, shown as the link.
 *
 * Reviews on disk still hold them — 24 on Crystal Society alone — and the
 * advice is as wrong as it was the day it was recorded. Recasting it on the way
 * to the screen fixes it without paying for a fresh review.
 */
function recastMerge(f, byOriginal, glossary) {
    if (f.action !== 'merge') return f;
    const a = byOriginal.get(String(f.entry || '').trim().toLowerCase());
    const b = byOriginal.get(String(f.mergeInto || '').trim().toLowerCase());
    if (!a || !b || !isNameForm(glossary, a.index, b.index)) return f;
    // The entry the merge would have deleted becomes the clone of the one it
    // kept: the same judgement, minus the lost spelling.
    return { ...f, action: 'link', linkTo: f.mergeInto, mergeInto: undefined, recast: 'merge' };
}

/**
 * A stable name for a finding, so a person's decision about it survives.
 *
 * Deliberately made of what the finding is *about* rather than where it sat:
 * "Hell should be deleted because it is junk" keeps the same name when the
 * review is run again, so an entry judged fine once does not have to be
 * defended every time. Two findings that agree on all three parts are near
 * duplicates and are happy to share a fate.
 */
export function findingKey(f) {
    return [f.action, String(f.entry || f.fix?.original || ''), f.issue].join('|').toLowerCase();
}

/**
 * The findings still worth showing, resolved against the glossary as it is now.
 *
 * Findings are matched to rows by the text of `original`, never by position.
 * Position was tried first and is wrong in both directions: deleting one row
 * shifted every finding below it onto the wrong entry, so the whole review had
 * to be discarded on any deletion — which meant accepting one proposal threw
 * away every proposal not yet looked at. And it still missed the case it existed
 * to catch, since renaming an entry to a string of the same length left the
 * indices intact and the findings pointing at something else.
 *
 * Matching by text needs no such guard, and it lets each finding answer for
 * itself: one that has been acted on disappears because the glossary now says
 * what it asked for, and one that has not stays until it is dealt with.
 *
 * @param {string} [bookText] the source, for retiring merges that would delete
 *   an entry the surviving one does not match — see losesCoverage.
 * @returns {{byRow: Array<Array<object>>, additions: Array, hidden: number}}
 */
export function outstandingFindings(review, glossary, bookText = '') {
    const byRow = glossary.map(() => []);
    const additions = [];
    const dismissed = new Set((review?.dismissed || []).map(k => String(k).toLowerCase()));
    let hidden = 0;

    const byOriginal = new Map();
    glossary.forEach((term, index) => {
        const key = String(term.original || '').trim().toLowerCase();
        if (key && !byOriginal.has(key)) byOriginal.set(key, { term, index });
    });
    const has = value => byOriginal.has(String(value || '').trim().toLowerCase());
    const { prime } = resolveLinks(glossary);

    for (const recorded of review?.findings || []) {
        // Keyed as recorded, so a dismissal made before a merge was recast as a
        // link still holds.
        const key = findingKey(recorded);
        if (dismissed.has(key)) { hidden++; continue; }
        const f = recastMerge(recorded, byOriginal, glossary);

        // A proposed entry that is now in the glossary was accepted.
        if (f.action === 'add') {
            const original = String(f.fix?.original || '').trim();
            if (original && !has(original)) additions.push({ ...f, key });
            continue;
        }

        // Gone from the glossary means dealt with — deleted outright, or renamed
        // by someone who had the finding in front of them.
        const target = byOriginal.get(String(f.entry || '').trim().toLowerCase());
        if (!target) continue;

        // A merge that would delete an entry the survivor cannot reach is refused
        // when a review is recorded — but reviews recorded before that check
        // existed are still on disk, and the advice in them is still on screen.
        // Applying the test here as well retires it without paying for a fresh
        // review, which is the only other way a person would ever be rid of it.
        if (f.action === 'merge' && bookText && has(f.mergeInto)
            && losesCoverage(target.term, byOriginal.get(String(f.mergeInto).trim().toLowerCase()).term, bookText)) continue;

        // A merge needs both halves; once one is gone there is nothing to merge.
        if (f.action === 'merge' && !has(f.mergeInto)) continue;

        // Linked after the review ran: the person answered it that way.
        if (f.action === 'merge'
            && linked(prime, target.index, byOriginal.get(String(f.mergeInto).trim().toLowerCase()).index)) continue;

        let linkTo;
        if (f.action === 'link') {
            const into = byOriginal.get(String(f.linkTo || '').trim().toLowerCase());
            if (!into) continue;
            const link = linkBetween(glossary, prime, target.index, into.index);
            // Done, or no longer possible; either way nothing to show.
            if (link.reason || link.clone !== target.index) continue;
            linkTo = glossary[link.head].original;
        }

        let fix = f.fix;
        if (f.action === 'edit') {
            // Only the fields that still differ. Applying half a proposal and
            // saving should leave the other half outstanding, not repeat the
            // part already done.
            fix = Object.fromEntries(Object.entries(f.fix || {}).filter(([field, value]) =>
                String(target.term[field] || '').trim() !== String(value).trim()));
            if (!Object.keys(fix).length) continue;
        }

        byRow[target.index].push({
            kind: 'model',
            detail: f.problem,
            action: f.action,
            issue: f.issue,
            quote: f.quote,
            fix,
            mergeInto: f.mergeInto,
            linkTo,
            key,
        });
    }
    return { byRow, additions, hidden };
}
