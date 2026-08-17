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
 * already there. Anything else is dropped and counted — a partly invented answer
 * degrades to fewer findings rather than to wrong ones.
 *
 * @param {Array} raw            the model's findings, as parsed
 * @param {Array} glossary       the glossary they refer to
 * @param {string} bookText      the joined source text
 * @returns {{findings: Array, rejected: object}}
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
    if (!Array.isArray(raw)) return { findings: [], rejected };

    const byOriginal = new Map();
    glossary.forEach((term, index) => {
        const key = String(term.original || '').trim().toLowerCase();
        if (key && !byOriginal.has(key)) byOriginal.set(key, { term, index });
    });

    const findings = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') { rejected.malformed++; continue; }

        const action = String(item.action || 'edit').trim().toLowerCase();
        if (!ACTIONS.has(action)) { rejected.malformed++; continue; }

        const entryKey = String(item.entry || '').trim().toLowerCase();
        const target = entryKey ? byOriginal.get(entryKey) : null;
        if (action !== 'add' && !target) { rejected.unknownEntry++; continue; }

        // The quote is the whole point of the contract, so it is checked before
        // anything else is considered.
        if (locateQuote(bookText, item.quote).occurrences === 0) { rejected.badQuote++; continue; }

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
            if (!into || into.index === target.index) { rejected.unknownTarget++; continue; }
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
            if (!wholeWordRegex(newOriginal, 'giu').test(bookText)) { rejected.absentOriginal++; continue; }
            fix.original = newOriginal;
        } else if (action === 'add') {
            rejected.malformed++; continue;
        }

        const translation = String(proposed.translation || '').trim();
        if (translation) fix.translation = translation;
        else if (action === 'add') { rejected.malformed++; continue; }

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
            if (!changes.length) { rejected.emptyFix++; continue; }
            finding.fix = Object.fromEntries(changes);
        } else {
            if (byOriginal.has(fix.original.toLowerCase())) { rejected.emptyFix++; continue; }
            finding.fix = fix;
        }

        findings.push(finding);
    }

    return { findings, rejected };
}

/**
 * Findings flattened per glossary row, in the shape the editor already renders
 * for the deterministic hygiene checks.
 *
 * @returns {Array<Array<object>>} indexed like the glossary
 */
export function reviewFindingsByRow(review, glossaryLength) {
    const rows = Array.from({ length: glossaryLength }, () => []);
    for (const f of review?.findings || []) {
        if (f.index === null || f.index === undefined || !rows[f.index]) continue;
        rows[f.index].push({
            kind: 'model',
            detail: f.problem,
            action: f.action,
            issue: f.issue,
            quote: f.quote,
            fix: f.fix,
            mergeInto: f.mergeInto,
        });
    }
    return rows;
}
