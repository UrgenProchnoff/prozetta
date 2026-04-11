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
        // 2. Try to find [...] (array)
        const arrayMatch = text.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
            jsonStr = arrayMatch[0];
        } else {
            // 3. Try to find {...} (object)
            const bracketMatch = text.match(/\{[\s\S]*\}/);
            if (bracketMatch) {
                jsonStr = bracketMatch[0];
            }
        }
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
                throw new Error(`Invalid JSON: ${e1.message}`);
            }
        }
    }
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
 * If tag is not found, tries unclosed <tag>... 
 * Final fallback: returns the full text trimmed.
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

    // Fallback: return full text
    return text.trim();
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
