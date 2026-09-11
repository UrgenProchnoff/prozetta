/**
 * Unified parsers for LLM response processing.
 * Handles JSON extraction (with fallbacks) and XML-tag extraction.
 */

// --- JSON Extraction ---

/**
 * Extract and parse JSON from LLM response text.
 * Tries: ```json blocks → [...] → {...} → raw parse.
 * Throws on failure.
 */
export function extractJson(text) {
    let jsonStr = null;

    // 1. Try ```json ... ``` block
    const jsonMatch = text.match(/```json([\s\S]*?)```/);
    if (jsonMatch) {
        jsonStr = jsonMatch[1];
    } else {
        // 2. No fence: take the OUTERMOST structure, whichever it is.
        //
        // Array-before-object was silently lossy. An answer shaped
        // {"score": 7, "summary": "…", "findings": [ … ]} has its first "[" inside
        // the object, so the array pattern matched the findings alone and
        // everything wrapping them was thrown away — measured on a real review of
        // Morphotrophic, which arrived with 63 findings, no score and no summary.
        //
        // Whichever candidate starts earlier is the one that contains the other,
        // so this also keeps a bare array a bare array: in "[{…}]" the bracket is
        // at 0 and the brace at 1.
        const arrayMatch = text.match(/\[[\s\S]*\]/);
        const objectMatch = text.match(/\{[\s\S]*\}/);
        const candidates = [arrayMatch, objectMatch].filter(Boolean).sort((a, b) => a.index - b.index);
        if (candidates.length) jsonStr = candidates[0][0];
    }

    if (!jsonStr) {
        throw new Error("No JSON found in response");
    }

    // Attempt 1: parse as-is
    try {
        return JSON.parse(jsonStr);
    } catch (e1) {
        // Attempt 2: fix unescaped quotes in string values
        const fixedStr = jsonStr.replace(
            /("(?:comment|notes|context)"\s*:\s*")([^"]*(?:"[^"]*)*?)("\s*[,}])/g,
            (match, prefix, content, suffix) => {
                const sanitized = content.replace(/"/g, "'");
                return prefix + sanitized + suffix;
            }
        );
        try {
            return JSON.parse(fixedStr);
        } catch (e2) {
            // Attempt 3: try parsing the whole text directly (edge case: clean JSON without code block)
            try {
                return JSON.parse(text.trim());
            } catch (e3) {
                // What was tried, and where it sat in the answer. An answer a
                // person pasted by hand is an answer a person can repair, and
                // the position in the error is counted inside the block while
                // they are looking at the whole reply — see describeJsonError.
                const err = new Error(`Invalid JSON: ${e1.message}`);
                err.source = jsonStr;
                err.offset = text.indexOf(jsonStr);
                throw err;
            }
        }
    }
}

/**
 * Where a failed parse went wrong, in terms of the answer a person is looking at.
 *
 * `JSON.parse` already says line and column, and saying only that is close to
 * useless for the commonest break of all. A model asked for one long field
 * sometimes writes it as two paragraphs and gives the second one no name:
 *
 *     "summary": "Перевод в целом читается…",
 *     "Основные проблемы мешают считать текст готовым…",
 *
 * The parser reads that second string as a property name and complains at the
 * comma that follows it — so the reported position is the end of a line that
 * looks perfectly fine, one line below the line that is actually wrong. A reader
 * sent there stares at a comma. So the culprit is walked back to where the
 * unnamed string begins, and the position is translated out of the extracted
 * block and into the pasted answer, which is the text they can edit.
 *
 * @param {string} text   the answer as pasted
 * @param {Error} error   what extractJson threw
 * @returns {{kind: 'none'|'broken', line?: number, column?: number,
 *            excerpt?: string, hint?: 'bare_string'}}
 */
export function describeJsonError(text, error) {
    const source = error?.source;
    if (typeof source !== 'string') return { kind: 'none' };

    const at = /at position (\d+)/.exec(String(error.message || ''));
    let index = at ? Number(at[1]) : 0;
    let hint;

    // "Expected ':' after property name": a string sat where a name belongs.
    if (/after property name/.test(String(error.message || ''))) {
        const start = startOfStringBefore(source, index);
        if (start >= 0) { index = start; hint = 'bare_string'; }
    }

    const offset = Number.isInteger(error.offset) && error.offset >= 0 ? error.offset : 0;
    const abs = Math.min(offset + index, text.length - 1);
    const before = text.slice(0, abs);
    const line = before.split('\n').length;
    const column = abs - (before.lastIndexOf('\n') + 1) + 1;
    const excerpt = (text.split('\n')[line - 1] || '').trim().slice(0, 300);

    return { kind: 'broken', line, column, excerpt, hint };
}

/** The opening quote of the string that ends just before `pos`, or -1. */
function startOfStringBefore(s, pos) {
    let i = pos - 1;
    while (i >= 0 && /\s/.test(s[i])) i--;
    if (s[i] !== '"') return -1;
    for (i--; i >= 0; i--) {
        if (s[i] !== '"') continue;
        // A quote is the opening one unless an odd run of backslashes escapes it.
        let b = i - 1, slashes = 0;
        while (b >= 0 && s[b] === '\\') { slashes++; b--; }
        if (slashes % 2 === 0) return i;
    }
    return -1;
}


/**
 * Extract check-result JSON from LLM response.
 * Never throws — always returns a valid check-result object.
 * Uses regex fallback for individual fields if JSON parsing fails.
 */
export function extractCheckResult(text) {
    const defaults = {
        error: 1,
        misspell: 0,
        correctness: 0,
        like: 0,
        score: 0,
        comment: "Parse error"
    };

    try {
        const data = extractJson(text);
        return {
            error: data.error ?? defaults.error,
            misspell: data.misspell ?? defaults.misspell,
            correctness: data.correctness ?? defaults.correctness,
            like: data.like ?? defaults.like,
            score: data.score ?? defaults.score,
            comment: data.comment || defaults.comment
        };
    } catch (e) {
        // Last resort: regex extraction for known fields
        const result = { ...defaults, comment: "Fallback regex parse: " + e.message };

        const errorMatch = text.match(/"error"\s*:\s*(\d+)/);
        const misspellMatch = text.match(/"misspell"\s*:\s*(\d+)/);
        const correctnessMatch = text.match(/"correctness"\s*:\s*(\d+)/);
        const likeMatch = text.match(/"like"\s*:\s*(\d+)/);
        const scoreMatch = text.match(/"score"\s*:\s*([\d.]+)/);

        if (errorMatch) result.error = parseInt(errorMatch[1]);
        if (misspellMatch) result.misspell = parseInt(misspellMatch[1]);
        if (correctnessMatch) result.correctness = parseInt(correctnessMatch[1]);
        if (likeMatch) result.like = parseInt(likeMatch[1]);
        if (scoreMatch) result.score = parseFloat(scoreMatch[1]);

        if (errorMatch || scoreMatch) {
            console.warn("[parsers] Used regex fallback due to malformed JSON.");
        } else {
            console.error("[parsers] Complete JSON parse failure, returning defaults.");
        }

        return result;
    }
}


// --- XML Tag Extraction ---

/**
 * Extract content from <tag>...</tag>.
 * An unclosed <tag> still yields its content — that is a truncated answer, and
 * the text after the opening tag is genuine.
 *
 * Returns null when the tag is absent altogether. Do NOT fall back to the whole
 * response here: without the tag it is the model's preamble and reasoning, and
 * returning it silently pastes that straight into the book. The caller decides
 * whether to retry or accept the raw text.
 */
export function extractFromTags(text, tag) {
    // Closed tag
    const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const match = text.match(regex);
    if (match) return match[1].trim();

    // Unclosed tag (LLM truncation)
    const startRegex = new RegExp(`<${tag}>([\\s\\S]*)`, 'i');
    const startMatch = text.match(startRegex);
    if (startMatch) return startMatch[1].trim();

    return null;
}

/**
 * Extract content from <tag>...</tag>, returns "" if tag not found.
 */
export function extractTagOptional(text, tag) {
    const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const match = text.match(regex);
    if (match) return match[1].trim();
    return "";
}
