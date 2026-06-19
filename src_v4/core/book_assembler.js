// Assemble the final translated book text from project chunks.
// Shared by the CLI export stage (writes a file) and the GUI download endpoint
// (serves on the fly), so both produce byte-identical output.

/**
 * Build the full book text: every chunk's translation in order, missing ones
 * marked, followed by the prozetta disclaimer.
 * @param {Array<{translation?: string}>} chunks
 * @param {string} modelName  model that produced the translation (for the disclaimer)
 * @returns {{ text: string, missing: number }}
 */
export function assembleBookText(chunks, modelName) {
    let text = '';
    let missing = 0;
    for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        if (c && c.translation) {
            text += c.translation + '\n';
        } else {
            text += `[MISSING CHUNK ${i}]\n`;
            missing++;
        }
    }

    text +=
        `\n\n---\n` +
        `Перевод сделан проектом prozetta — помощник переводчика.\n` +
        `Модель: ${modelName}.\n` +
        `GitHub: <ссылка будет добавлена позже>\n`;

    return { text, missing };
}
