/**
 * Reviewing the glossary against the book it belongs to.
 *
 * The glossary is built by Stage 1b in batches of thirty terms, and a batch sees
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

import { wholeWordRegex } from './text_stats.js';
import { locateQuote } from './quoted_spans.js';

/** Actions a finding may propose. Nothing is ever applied automatically. */
const ACTIONS = new Set(['edit', 'add', 'merge', 'remove']);

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
 * `occurrences` tells the model which entries are real; `exactCase` separates a
 * proper noun from the common word it collides with, since the cheat sheet
 * matches case-insensitively. Measured on Halting State: "NICE" (an
 * organisation) fires 20 times of which 1 is the organisation, "M" fires 185
 * times of which 178 are the "m" in "I'm", "Hell" fires 52 times of which 45 are
 * the swear word. No amount of reading tells the model that; counting does.
 */
export function glossaryEvidence(glossary, bookText) {
    return glossary.map(term => {
        const original = String(term.original || '').trim();
        const all = original ? (bookText.match(wholeWordRegex(original, 'giu')) || []) : [];
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
        if (all.length && exact !== all.length) row.exactCase = exact;
        return row;
    });
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
        });
    };

    if (!Array.isArray(raw)) return { findings: [], rejected, rejectedFindings };

    const byOriginal = new Map();
    glossary.forEach((term, index) => {
        const key = String(term.original || '').trim().toLowerCase();
        if (key && !byOriginal.has(key)) byOriginal.set(key, { term, index });
    });

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

        if (action === 'merge') {
            const intoKey = String(item.mergeInto || '').trim().toLowerCase();
            const into = byOriginal.get(intoKey);
            if (!into || into.index === target.index) { drop('unknownTarget', item); continue; }
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
            if (!wholeWordRegex(newOriginal, 'giu').test(bookText)) { drop('absentOriginal', item); continue; }
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
        } else {
            if (byOriginal.has(fix.original.toLowerCase())) { drop('emptyFix', item); continue; }
            finding.fix = fix;
        }

        findings.push(finding);
    }

    return { findings, rejected, rejectedFindings };
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
 * @returns {{byRow: Array<Array<object>>, additions: Array, hidden: number}}
 */
export function outstandingFindings(review, glossary) {
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

    for (const f of review?.findings || []) {
        const key = findingKey(f);
        if (dismissed.has(key)) { hidden++; continue; }

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

        // A merge needs both halves; once one is gone there is nothing to merge.
        if (f.action === 'merge' && !has(f.mergeInto)) continue;

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
            key,
        });
    }
    return { byRow, additions, hidden };
}
