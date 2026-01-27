import { fromPreTrained } from "@lenml/tokenizer-gemma3";

const TOKENS_LIMIT_1 = 500;
const TOKENS_LIMIT_2 = 500;

let tokenizer = null;

function initTokenizer() {
    if (!tokenizer) {
        tokenizer = fromPreTrained();
    }
    return tokenizer;
}

function countTokens(text) {
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
export function splitTextIntoChunks(text) {
    console.log('[Tokenizer] Splitting text into chunks...');

    // Normalize line endings
    const cleanText = text.replace(/\r\n/g, '\n');
    const lines = cleanText.split('\n');

    let chunks = [];
    let base_fragment = '';
    let raw_additional_fragment = '';

    // Simple accumulator logic adapted from index10.js but cleaned up
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i] + '\n';

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
    if (base_fragment || raw_additional_fragment) {
        chunks.push({
            original: base_fragment + raw_additional_fragment,
            tokens: countTokens(base_fragment + raw_additional_fragment)
        });
    }

    console.log(`[Tokenizer] Created ${chunks.length} chunks.`);
    return chunks;
}

// Reuse logic from index10.js for smart splitting
function splitFragment(fragment) {
    let split_fragment = {
        base_fragment: '',
        additional_fragment: '',
    }
    const lines = fragment.split('\n');
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
