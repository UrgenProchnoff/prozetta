/**
 * The book's headings, marked by a model instead of guessed by keyword.
 *
 * The keyword heuristic in book_assembler.js knows "Часть 1" and "Глава IV" and
 * nothing it was not taught: "Часть первая" became a paragraph at the end of a
 * prologue, and in Crystal Society "Часть первая:", "Создатели" and "Глава
 * первая" were all missed. Teaching it every language's ordinals is the wrong
 * road, so the language-dependent part is handed to a model and the code keeps
 * only what holds in any language: a heading is a short line standing alone,
 * not ending a sentence.
 *
 * Only those lines are sent, each with a line of context either side — not the
 * book. Measured on Crystal Society, the largest: 306 candidates, 21,517 tokens
 * against 255,000 for the book itself.
 *
 * The result is stored per project and keyed by chunk and text, not by
 * position, so editing one chunk leaves the marks on the others standing.
 */

import fs from 'fs';
import { fingerprint, fingerprintMismatch } from './book_call.js';
import { countTokens } from './tokenizer.js';
import { writeFileAtomic } from '../utils/atomic_write.js';

const MAX_HEADING = 80;
// Sentence-final marks across scripts. A line ending in one is a sentence, not
// a heading — except a very short one, where "12." and "Глава 1." live.
const SENTENCE_END = /[.!?…»”"。！？]$/u;
const SHORT_WITH_PERIOD = 3;
const CONTEXT = 120;

/** Lines as the assembler sees them: one chunk's translation, trimmed. */
function chunkLines(chunk) {
    return String(chunk?.translation || '').split('\n').map(l => l.trim());
}

function isCandidate(line) {
    if (!line || line.length > MAX_HEADING) return false;
    if (/^[—–-]/.test(line)) return false;                 // a line of dialogue
    if (!SENTENCE_END.test(line)) return true;
    return /[^.]\.$/.test(line) && line.split(/\s+/).length <= SHORT_WITH_PERIOD;
}

/** The key a mark is stored under: which chunk, which text, which occurrence. */
function keyOf(chunk, text, nth) {
    return `${chunk}\u0000${text}\u0000${nth}`;
}

/**
 * Every line that could be a heading, in book order, with its neighbours.
 * @returns {Array<{id: number, chunk: number, key: string, text: string, before: string, after: string}>}
 */
export function structureCandidates(chunks) {
    const out = [];
    let prevLine = '';
    for (let ci = 0; ci < chunks.length; ci++) {
        const lines = chunkLines(chunks[ci]).filter(Boolean);
        const seen = new Map();
        for (let li = 0; li < lines.length; li++) {
            const text = lines[li];
            const before = li > 0 ? lines[li - 1] : prevLine;
            if (isCandidate(text)) {
                const nth = seen.get(text) || 0;
                seen.set(text, nth + 1);
                out.push({
                    id: out.length + 1, chunk: ci, key: keyOf(ci, text, nth), text,
                    before: before.slice(0, CONTEXT),
                    after: (lines[li + 1] ?? chunkLines(chunks[ci + 1]).find(Boolean) ?? '').slice(0, CONTEXT),
                });
            }
        }
        if (lines.length) prevLine = lines[lines.length - 1];
    }
    return out;
}

/**
 * The model's answer as stored marks. Only ids that exist count; levels are
 * whole numbers 1–3; "joinPrev" holds only when the previous candidate is the
 * line right before this one and is itself a heading.
 */
export function marksFromAnswer(answer, candidates) {
    const byId = new Map(candidates.map(c => [c.id, c]));
    const raw = Array.isArray(answer?.headings) ? answer.headings : [];
    const marks = [];
    const marked = new Set();
    for (const h of raw.slice().sort((a, b) => Number(a?.id) - Number(b?.id))) {
        const c = byId.get(Number(h?.id));
        const level = Math.round(Number(h?.level));
        if (!c || marked.has(c.id) || !(level >= 1 && level <= 3)) continue;
        const prev = byId.get(c.id - 1);
        const joinPrev = !!h?.joinPrev && !!prev && marked.has(prev.id) && prev.chunk <= c.chunk && c.before === prev.text;
        marks.push({ key: c.key, text: c.text, level, ...(joinPrev ? { joinPrev: true } : {}) });
        marked.add(c.id);
    }
    return marks;
}

/**
 * How the stored marks sit on the translation as it is now.
 * @returns {{byKey: Map<string, object>, matched: number, lost: number, unmarked: number}}
 *   `lost` — marks whose line is gone; `unmarked` — candidates the model has
 *   never seen, because they appeared after it was asked.
 */
export function matchStructure(structure, candidates) {
    const marks = structure?.marks || [];
    const byKey = new Map(marks.map(m => [m.key, m]));
    const asked = new Set(structure?.asked || []);
    let matched = 0;
    let unmarked = 0;
    const present = new Set();
    for (const c of candidates) {
        present.add(c.key);
        if (byKey.has(c.key)) matched++;
        if (!asked.has(c.key)) unmarked++;
    }
    const lost = marks.filter(m => !present.has(m.key)).length;
    return { byKey, matched, lost, unmarked };
}

/**
 * The outline the marks give: one row per heading, joined titles together.
 * @returns {Array<{level: number, title: string[], chunk: number}>}
 */
export function outline(candidates, byKey) {
    const rows = [];
    for (const c of candidates) {
        const m = byKey.get(c.key);
        if (!m) continue;
        if (m.joinPrev && rows.length) rows[rows.length - 1].title.push(c.text);
        else rows.push({ level: m.level, title: [c.text], chunk: c.chunk });
    }
    return rows;
}

export function loadStructure(file) {
    if (!fs.existsSync(file)) return null;
    try {
        const s = JSON.parse(fs.readFileSync(file, 'utf-8'));
        return s && Array.isArray(s.marks) ? s : null;
    } catch {
        return null;
    }
}

/** For the assembler: chunk → line text → mark, for lines that are headings. */
export function headingLookup(chunks, structure) {
    if (!structure?.marks?.length) return null;
    const { byKey } = matchStructure(structure, structureCandidates(chunks));
    if (!byKey.size) return null;
    return (chunkIndex, text, nth) => byKey.get(keyOf(chunkIndex, text, nth)) || null;
}

/**
 * What the model is to be asked. Split from taking the answer, like the
 * whole-book calls, so the request can be carried to a web console by hand.
 * The fingerprint is over the candidates: the answer names them by number, and
 * a number means nothing once the lines it counted have changed.
 *
 * @throws {Error} when there is nothing to mark
 */
export function buildStructurePrompt(chunks, prompts) {
    const candidates = structureCandidates(chunks);
    if (!candidates.length) throw new Error('No lines that could be headings — nothing to mark.');
    const system = prompts.bookStructure.system();
    const user = prompts.bookStructure.user(candidates);
    const tokens = { book: 0, evidence: countTokens(user), instructions: countTokens(system) };
    tokens.total = tokens.evidence + tokens.instructions;
    return { system, user, tokens, candidates, fingerprint: fingerprint(...candidates.map(c => c.key)), warnings: [] };
}

/**
 * Take an answer, however it was obtained, and store the marks.
 * @throws {Error} when the answer was made from other candidates
 */
export function applyStructureAnswer(chunks, answer, file, meta = {}) {
    const candidates = structureCandidates(chunks);
    const stale = fingerprintMismatch(fingerprint(...candidates.map(c => c.key)), meta.fingerprint);
    if (stale) throw new Error(stale);
    const marks = marksFromAnswer(answer, candidates);
    writeFileAtomic(file, JSON.stringify({
        model: meta.model || null,
        generatedAt: new Date().toISOString(),
        // What the model saw, so a line added later can be told from one it
        // judged and left out.
        asked: candidates.map(c => c.key),
        marks,
    }, null, 2));
    return { marks, candidates };
}
