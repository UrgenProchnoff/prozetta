import { fromPreTrained } from "@lenml/tokenizer-gemma3";
import config from '../config.js';
import { isHeading } from './book_assembler.js';

const TOKENS_LIMIT_1 = config.pipeline.chunkBaseTokens;
const TOKENS_LIMIT_2 = config.pipeline.chunkOverflowTokens;

let tokenizer = null;

function initTokenizer() {
    if (!tokenizer) {
        tokenizer = fromPreTrained();
    }
    return tokenizer;
}

export function countTokens(text) {
    try {
        const t = initTokenizer();
        let encoded = t.encode(text);
        return encoded.length;
    } catch (error) {
        // Fallback: 1 word ~ 1.3 tokens. 
        // A rough estimate is better than a crash in production loop.
        const estimate = Math.ceil(text.length / 3);
        console.warn(`[Tokenizer] Error counting tokens, using estimate: ${estimate}. Error: ${error.message}`);
        return estimate;
    }
}


/**
 * Splits text into processable chunks optimizing for sentence/paragraph boundaries
 * @param {string} text 
 * @returns {Array<{original: string, tokens: number}>}
 */
// Minimum size of the text a heading opens for that heading to count as a real
// chapter break. Without it every `NAME:` line in an SMS exchange ("ELAINE: WTF?")
// would start its own chunk and shred the scene into fragments.
const MIN_SECTION_CHARS = 800;

/**
 * Line numbers where a new chapter starts. A chunk must never span one: with a
 * chapter break inside, a single chunk carries two different scenes — and in
 * multi-POV books, two different narrators — into one translation request.
 */
// Chapters titled by their point-of-view character: "SUE: Grand Theft Automatic".
// isHeading() rejects these (the title part has lowercase letters), yet they are
// the real chapter breaks in multi-POV novels. The same shape also labels lines
// in a chat transcript ("ELAINE: WTF?") — MIN_SECTION_CHARS is what separates
// the two, so this pattern is deliberately loose.
const SPEAKER_HEADING = /^\p{Lu}[\p{Lu}\s.'-]{1,30}:\s*\S/u;

function findChapterBreaks(lines) {
    const candidates = [];
    lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (isHeading(trimmed) || SPEAKER_HEADING.test(trimmed)) candidates.push(i);
    });

    const breaks = new Set();
    candidates.forEach((idx, k) => {
        const nextIdx = candidates[k + 1] ?? lines.length;
        const sectionChars = lines.slice(idx, nextIdx).join('\n').length;
        if (sectionChars >= MIN_SECTION_CHARS) breaks.add(idx);
    });
    return breaks;
}

/**
 * Turn character offsets into the line numbers that open a new chunk.
 *
 * The point-of-view boundaries a model reports are positions in the text, while
 * the splitter works in lines. A boundary landing inside a line starts the chunk
 * at that line: a break cannot be finer than the paragraph anyway.
 */
function linesForOffsets(lines, offsets) {
    const breaks = new Set();
    if (!offsets?.length) return breaks;

    const sorted = [...offsets].filter(o => Number.isFinite(o) && o > 0).sort((a, b) => a - b);
    let lineStart = 0, next = 0;
    for (let i = 0; i < lines.length && next < sorted.length; i++) {
        const lineEnd = lineStart + lines[i].length + 1;   // +1 for the '\n'
        while (next < sorted.length && sorted[next] < lineEnd) {
            breaks.add(i);
            next++;
        }
        lineStart = lineEnd;
    }
    return breaks;
}

/**
 * @param {string} text
 * @param {number[]} [extraBreakOffsets] character offsets that must open a new
 *   chunk — used to re-split a book once a model has reported where its point of
 *   view changes. Without them a heading-less multi-POV book gets boundaries
 *   buried mid-chunk (measured: 28 of 36), and each such chunk carries two
 *   narrators into one translation request.
 */
export function splitTextIntoChunks(text, extraBreakOffsets = []) {
    console.log('[Tokenizer] Splitting text into chunks...');

    // Normalize line endings
    const cleanText = text.replace(/\r\n/g, '\n');
    const lines = cleanText.split('\n');
    const chapterBreaks = findChapterBreaks(lines);
    for (const line of linesForOffsets(lines, extraBreakOffsets)) chapterBreaks.add(line);
    if (chapterBreaks.size) {
        console.log(`[Tokenizer] Found ${chapterBreaks.size} break(s) — chunks will not span them` +
            `${extraBreakOffsets?.length ? ` (${extraBreakOffsets.length} supplied by the point-of-view map)` : ''}.`);
    }

    let chunks = [];
    let base_fragment = '';
    let raw_additional_fragment = '';

    // A chapter's last few paragraphs are usually too short to stand alone. They
    // belong to the same chapter as the chunk before them (chunks never span a
    // break), so append rather than emit a stub.
    const MIN_TAIL_TOKENS = 300;
    // Ceiling for the merge. In a book of many short sections the tails would
    // otherwise pile onto the same chunk and blow it up several times over.
    const MAX_MERGED_TOKENS = TOKENS_LIMIT_1 + TOKENS_LIMIT_2 + MIN_TAIL_TOKENS;

    const flush = () => {
        const pending = base_fragment + raw_additional_fragment;
        base_fragment = '';
        raw_additional_fragment = '';
        if (!pending.trim()) return;

        const tokens = countTokens(pending);
        const prev = chunks[chunks.length - 1];
        if (prev && tokens < MIN_TAIL_TOKENS && prev.tokens + tokens <= MAX_MERGED_TOKENS) {
            prev.original += pending;
            prev.tokens = countTokens(prev.original);
            return;
        }
        chunks.push({ original: pending, tokens });
    };

    // Simple accumulator logic adapted from index10.js but cleaned up
    for (let i = 0; i < lines.length; i++) {
        // Splitting on '\n' leaves a final empty element for a text that ends
        // with one, and appending a newline to that element invented a character
        // the book never had: the reassembled text came out one byte longer than
        // the source. Carrying extraction across a re-split maps terms by offset,
        // and an axis that does not reconstruct is not an axis.
        let line = lines[i] + (i < lines.length - 1 ? '\n' : '');

        // A chapter starts here: close whatever has accumulated so the heading
        // opens a fresh chunk instead of being buried mid-chunk.
        if (chapterBreaks.has(i)) flush();

        // If base is empty or small, add to base
        if (countTokens(base_fragment) < TOKENS_LIMIT_1) {
            base_fragment += line;
        } else {
            // Base is full, start adding to additional
            raw_additional_fragment += line;

            // Check if additional is full
            if (countTokens(raw_additional_fragment) >= TOKENS_LIMIT_2) {
                // Split the additional fragment smartly
                const split = splitFragment(raw_additional_fragment);

                // Form the chunk
                const chunkText = base_fragment + split.base_fragment;

                chunks.push({
                    original: chunkText,
                    tokens: countTokens(chunkText)
                });

                // Reset for next iteration
                base_fragment = split.additional_fragment;
                raw_additional_fragment = '';
            }
        }
    }

    // Add remaining text
    flush();

    console.log(`[Tokenizer] Created ${chunks.length} chunks.`);
    return chunks;
}

// Reuse logic from index10.js for smart splitting
function splitFragment(fragment) {
    let split_fragment = {
        base_fragment: '',
        additional_fragment: '',
    }
    // Every line is written back with a '\n' appended below. The fragment
    // already ends with one, so splitting leaves a trailing empty element that
    // would earn a second newline — one extra blank line per split, drifting the
    // text a character further from the source with every chunk emitted.
    const lines = fragment.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    let bestBreakIndex = -1;

    // Search for: Empty line > Paragraph start > End of sentence

    // 1. Empty lines
    for (let i = lines.length - 2; i >= 0; i--) {
        if (lines[i].trim() === '') {
            bestBreakIndex = i;
            break;
        }
    }

    // 2. If no empty lines, look for paragraph starts (indentation)
    if (bestBreakIndex === -1) {
        for (let i = lines.length - 1; i >= 1; i--) {
            if (lines[i].startsWith('  ') || lines[i].startsWith('\t')) {
                bestBreakIndex = i - 1;
                break;
            }
        }
    }

    // 3. Fallback: just split at the end (or find a period)
    if (bestBreakIndex === -1) {
        bestBreakIndex = lines.length - 1;
    }

    // Construct return object
    for (let i = 0; i < lines.length; i++) {
        if (i <= bestBreakIndex) {
            split_fragment.base_fragment += lines[i] + '\n';
        } else {
            split_fragment.additional_fragment += lines[i] + '\n';
        }
    }

    return split_fragment;
}
