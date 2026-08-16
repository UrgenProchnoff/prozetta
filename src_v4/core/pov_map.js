import { wholeWordRegex } from './text_stats.js';
import { profileForText, quotedSpeechRegex, CJK_HEADING } from './language.js';

/**
 * Which point-of-view character each chunk belongs to.
 *
 * Not a per-chunk classification problem. A reader does not identify the
 * narrator of chapter fourteen from scratch — they carry the previous answer
 * forward and re-sync on the rare occasion someone says the name out loud. That
 * is what this does: rare but strong anchors, a rotation prior, and a Viterbi
 * pass that lets the two correct each other.
 *
 * Measured against chapter headings in an existing project (Halting State):
 *   asking an LLM per segment, closed candidate list  — 66%
 *   anchors alone (name spoken in dialogue)           — 53% coverage, 85% precise
 *   rotation regularity alone                         — 91%
 *   both, combined here                               — 100% on segments,
 *                                                       95.5% expanded to chunks
 *                                                       (old, non-chapter-aligned
 *                                                       chunking; 69 of 71
 *                                                       anchor-less chunks right)
 * Doing the same at chunk granularity instead of segments collapses to 44%:
 * a chunk is small enough that someone addressing another character in it
 * produces a false anchor, and anchor precision drops from 85% to 64%.
 *
 * The cast of point-of-view characters is NOT derived here. It is the one input
 * that statistics cannot supply and that a whole-book LLM call — or the user —
 * answers in one go.
 */

// A chapter titled by its point-of-view character: "SUE: Grand Theft Automatic".
// Case-based, so it is inert on Han, kana and Hangul — where CJK_HEADING in
// language.js catches "第一章" instead.
const SPEAKER_HEADING = /^[ \t]*\p{Lu}[\p{Lu}\s.'-]{1,30}:\s*\S/mu;

// Transition prior. A chapter break usually hands over to the next character in
// the rotation; staying is possible (a chapter split across scene breaks);
// jumping out of order is rare but not impossible.
const P_FOLLOW = 0.80;
const P_STAY = 0.12;
const P_OTHER = 0.08;
// Anchors are evidence, not truth — 85% of them were right when measured, and
// treating them as certain would let the 15% drag whole chapters with them.
const P_ANCHOR_OK = 0.85;

function wholeWord(name) {
    return wholeWordRegex(name, 'iu');
}

/**
 * Group chunks into segments, starting a new one at every chunk that opens with
 * a chapter heading. With chapter-aware chunking a segment is exactly a chapter;
 * on projects chunked before that, a heading buried mid-chunk puts the boundary
 * one chunk late, which costs the boundary chunk and nothing else.
 * @returns {Array<{from: number, to: number}>} inclusive chunk ranges
 */
export function buildSegments(chunks) {
    const segments = [];
    chunks.forEach((chunk, i) => {
        const text = chunk.original || '';
        const opensChapter = SPEAKER_HEADING.test(text) || CJK_HEADING.test(text.split('\n')[0].trim());
        if (!segments.length || opensChapter) segments.push({ from: i, to: i });
        else segments[segments.length - 1].to = i;
    });
    return segments;
}

/**
 * The anchor of a segment: a cast member named inside quoted speech. In
 * first- and second-person narration the narrator's own name barely appears in
 * the narrative text — but people address them out loud. Two different cast
 * members in the same segment cancel out; that is ambiguity, not evidence.
 */
function findAnchor(text, cast) {
    // Quote marks differ by language — 「」 and 『』 in Japanese, both those and
    // “” in Chinese — so the pattern comes from the script profile.
    const speech = (text.match(quotedSpeechRegex(profileForText(text))) || []).join(' ');
    const found = cast.filter(name => wholeWord(name).test(speech));
    return found.length === 1 ? found[0] : null;
}

/** Who follows whom, learned from consecutive anchors that disagree. */
function learnRotation(cast, anchors) {
    const successors = {};
    let previous = null;
    for (const anchor of anchors) {
        if (!anchor) continue;
        if (previous && previous !== anchor) {
            successors[previous] = successors[previous] || {};
            successors[previous][anchor] = (successors[previous][anchor] || 0) + 1;
        }
        previous = anchor;
    }

    const nextOf = {};
    for (const name of cast) {
        const ranked = Object.entries(successors[name] || {}).sort((a, b) => b[1] - a[1]);
        nextOf[name] = ranked.length ? ranked[0][0] : null;
    }
    return nextOf;
}

function viterbi(cast, anchors, nextOf) {
    const wrongAnchor = cast.length > 1 ? (1 - P_ANCHOR_OK) / (cast.length - 1) : 1;
    const transition = (from, to) =>
        to === nextOf[from] ? P_FOLLOW : to === from ? P_STAY : P_OTHER;
    const emission = (i, state) => {
        const anchor = anchors[i];
        if (!anchor) return 1 / cast.length;      // no evidence: let the prior decide
        return anchor === state ? P_ANCHOR_OK : wrongAnchor;
    };

    const score = [], backPointer = [];
    score[0] = Object.fromEntries(cast.map(s => [s, Math.log(emission(0, s) / cast.length)]));

    for (let i = 1; i < anchors.length; i++) {
        score[i] = {};
        backPointer[i] = {};
        for (const current of cast) {
            let best = -Infinity, from = null;
            for (const previous of cast) {
                const value = score[i - 1][previous] + Math.log(transition(previous, current));
                if (value > best) { best = value; from = previous; }
            }
            score[i][current] = best + Math.log(emission(i, current));
            backPointer[i][current] = from;
        }
    }

    const last = anchors.length - 1;
    const path = new Array(anchors.length);
    path[last] = Object.entries(score[last]).sort((a, b) => b[1] - a[1])[0][0];
    for (let i = last; i > 0; i--) path[i - 1] = backPointer[i][path[i]];
    return path;
}

/**
 * Build the point-of-view map.
 *
 * @param {Array<{original: string}>} chunks
 * @param {string[]} cast  point-of-view character names, from the passport
 * @returns {Array<{fromChunk: number, toChunk: number, character: string|null,
 *                  source: 'anchor'|'inferred'}>}
 *   Empty when there is nothing to decide: with a single narrator the map adds
 *   nothing over the passport's one character, and with none we cannot guess.
 */
export function buildPovMap(chunks, cast) {
    if (!Array.isArray(cast) || cast.length < 2 || !chunks.length) return [];

    const segments = buildSegments(chunks);
    const anchors = segments.map(segment =>
        findAnchor(chunks.slice(segment.from, segment.to + 1).map(c => c.original).join('\n'), cast)
    );

    if (!anchors.some(Boolean)) return [];   // nothing to sync to: do not invent

    const path = viterbi(cast, anchors, learnRotation(cast, anchors));

    // Collapse neighbouring segments that resolved to the same character.
    const spans = [];
    segments.forEach((segment, i) => {
        const character = path[i];
        const source = anchors[i] ? 'anchor' : 'inferred';
        const last = spans[spans.length - 1];
        if (last && last.character === character) {
            last.toChunk = segment.to;
            if (source === 'anchor') last.source = 'anchor';
        } else {
            spans.push({ fromChunk: segment.from, toChunk: segment.to, character, source });
        }
    });
    return spans;
}

/** Coverage stats for the log and the GUI, so a weak map is visible as weak. */
export function describePovMap(chunks, cast) {
    const segments = buildSegments(chunks);
    const anchors = segments.map(segment =>
        findAnchor(chunks.slice(segment.from, segment.to + 1).map(c => c.original).join('\n'), cast || [])
    );
    return {
        segments: segments.length,
        anchors: anchors.filter(Boolean).length,
        rotation: learnRotation(cast || [], anchors),
    };
}
