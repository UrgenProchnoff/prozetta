// Assemble the final translated book text from project chunks.
// Shared by the CLI export stage (writes a file) and the GUI download endpoint
// (serves on the fly), so both produce byte-identical output.

import crypto from 'node:crypto';
import { CJK_HEADING } from './language.js';

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
        `GitHub: https://github.com/UrgenProchnoff/prozetta\n`;

    return { text, missing };
}

// ---------------------------------------------------------------------------
// FB2 export
// ---------------------------------------------------------------------------

function escXml(s) {
    return String(s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

// Chapter-heading heuristic for plain prose. Deliberately conservative: a false
// "heading" breaks the book into a bogus section, while a missed one merely
// leaves two chapters in one section.
const HEADING_KEYWORD = /^(глава|часть|книга|том|пролог|эпилог|интерлюдия|эпиграф|предисловие|послесловие|chapter|part|book|volume|prologue|epilogue|interlude|foreword|afterword|rozdział|część|prolog|epilog|tom)$/i;
const HEADING_KEYWORD_NUMBERED = /^(глава|часть|книга|том|chapter|part|book|volume|rozdział|część|tom)\s+(\d{1,4}|[IVXLCDM]{1,8})\b[\s.:—–-]*(.{0,60})?$/i;
// A chapter numbered with a spelled-out word: "ПЯТЬ. Семья Во", "TWELVE".
// The word must be the whole line or be followed by ".", ":" — a plain space
// after it ("Три дня спустя…") reads as ordinary prose, not a heading.
const NUMBER_WORD = '(ОДИН|ДВА|ТРИ|ЧЕТЫРЕ|ПЯТЬ|ШЕСТЬ|СЕМЬ|ВОСЕМЬ|ДЕВЯТЬ|ДЕСЯТЬ|ОДИННАДЦАТЬ|ДВЕНАДЦАТЬ|ТРИНАДЦАТЬ|ЧЕТЫРНАДЦАТЬ|ПЯТНАДЦАТЬ|ШЕСТНАДЦАТЬ|СЕМНАДЦАТЬ|ВОСЕМНАДЦАТЬ|ДЕВЯТНАДЦАТЬ|ДВАДЦАТЬ|ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|TEN|ELEVEN|TWELVE|THIRTEEN|FOURTEEN|FIFTEEN|SIXTEEN|SEVENTEEN|EIGHTEEN|NINETEEN|TWENTY)';
const HEADING_NUMBER_WORD = new RegExp(`^${NUMBER_WORD}(?:[.:]\\s*.{0,60})?$`, 'u');

export function isHeading(line) {
    if (line.length > 80) return false;
    // "第一章 归途", "第12話", "제3장" — scripts with no case, so none of the
    // heuristics below can see them.
    if (CJK_HEADING.test(line)) return true;
    if (HEADING_KEYWORD.test(line)) return true;                 // "Пролог", "Эпилог"
    if (HEADING_KEYWORD_NUMBERED.test(line)) return true;        // "Глава 7. Погоня"
    if (HEADING_NUMBER_WORD.test(line)) return true;             // "ПЯТЬ. Семья Во"
    if (/^\d{1,4}\.?$/.test(line)) return true;                  // bare "12" / "12."
    if (/^[IVXLCDM]{1,8}\.?$/.test(line)) return true;           // bare roman "XIV"
    // Short ALL-CAPS line ("ГЛАВА ПЕРВАЯ"): no lowercase letters, no dialogue
    // or sentence punctuation ("ТУК. ТУК. ТУК." is shouting, not a heading).
    if (line.length <= 50
        && /\p{Lu}/u.test(line)
        && !/\p{Ll}/u.test(line)
        && !/[!?"«»„“:;,.[\]()]/.test(line)
        && !/…/.test(line)) return true;
    return false;
}

// A scene-break separator line: "* * *", "***", "---", "———" etc.
function isSeparator(line) {
    return /^[*\s]{3,}$/.test(line) || /^[-—–_]{3,}$/.test(line);
}

// Map the project's file suffix to an FB2/ISO language code.
const LANG_BY_SUFFIX = {
    rus: 'ru', ru: 'ru', eng: 'en', en: 'en', deu: 'de', ger: 'de', de: 'de',
    fra: 'fr', fre: 'fr', fr: 'fr', spa: 'es', es: 'es', ita: 'it', it: 'it',
    pol: 'pl', pl: 'pl', ukr: 'uk', ua: 'uk', uk: 'uk', pt: 'pt', por: 'pt',
};
function langCode(suffix) {
    const s = String(suffix || 'rus').toLowerCase();
    return LANG_BY_SUFFIX[s] || s.slice(0, 2);
}

// "Имя Отчество Фамилия" → FB2 author parts (last word = last name).
function authorXml(author) {
    const words = String(author || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '';
    if (words.length === 1) return `<author><last-name>${escXml(words[0])}</last-name></author>`;
    const last = words[words.length - 1];
    const first = words.slice(0, -1).join(' ');
    return `<author><first-name>${escXml(first)}</first-name><last-name>${escXml(last)}</last-name></author>`;
}

// Stable per-book document id so re-exports update (not duplicate) the book in
// reader libraries.
function bookUuid(seed) {
    const h = crypto.createHash('sha1').update(String(seed)).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Build an FB2 (FictionBook 2.0) document from project chunks.
 * Sections are cut by a chapter-heading heuristic; when no headings are found
 * the whole book becomes one untitled section (still valid FB2).
 *
 * @param {Array<{translation?: string}>} chunks
 * @param {{
 *   title: string, author?: string, annotation?: string, langSuffix?: string,
 *   modelName?: string, cover?: { base64: string, mime: string } | null,
 *   headingAt?: (chunk: number, text: string, nth: number) => ({level: number, joinPrev?: boolean}|null)
 * }} meta
 *   `headingAt` — the model's marks (core/book_structure.js headingLookup);
 *   without it headings are guessed by keyword.
 * @returns {{ xml: string, missing: number, sections: number }}
 */
export function assembleBookFb2(chunks, meta) {
    let missing = 0;
    // Each line keeps the chunk it came from and its occurrence there, which is
    // how the model's marks (core/book_structure.js) find it again.
    const lines = [];
    for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        if (c && c.translation) {
            const seen = new Map();
            for (const raw of c.translation.split('\n')) {
                const text = raw.trim();
                const nth = seen.get(text) || 0;
                seen.set(text, nth + 1);
                lines.push({ text, chunk: i, nth });
            }
        } else {
            lines.push({ text: `[MISSING CHUNK ${i}]`, chunk: i, nth: 0 });
            missing++;
        }
    }

    // Marked by a model when there are marks; the keyword heuristic otherwise,
    // as a flat run of sections — what every book got before marks existed.
    const lookup = typeof meta.headingAt === 'function' ? meta.headingAt : null;
    const headingOf = lookup
        ? (l) => lookup(l.chunk, l.text, l.nth)
        : (l) => (isHeading(l.text) ? { level: 1 } : null);

    // Sections as a tree: a heading closes every open section of its level or
    // deeper and opens one under the nearest shallower one.
    const root = { level: 0, title: [], items: [], children: [] };
    const stack = [root];
    let count = 0;
    for (const line of lines) {
        if (!line.text) continue;
        const mark = headingOf(line);
        if (mark) {
            const top = stack[stack.length - 1];
            // The second line of a two-line title ("Часть первая:" / "Создатели"),
            // as long as nothing has been written under the first.
            if (mark.joinPrev && top !== root && !top.items.length && !top.children.length) {
                top.title.push(line.text);
                continue;
            }
            while (stack.length > 1 && stack[stack.length - 1].level >= mark.level) stack.pop();
            const section = { level: mark.level, title: [line.text], items: [], children: [] };
            stack[stack.length - 1].children.push(section);
            stack.push(section);
            count++;
        } else {
            // Always the deepest open section: a section is closed only by the
            // next heading, so the one on top has no subsections yet.
            stack[stack.length - 1].items.push(isSeparator(line.text)
                ? { kind: 'subtitle', text: '* * *' }
                : { kind: 'p', text: line.text });
        }
    }

    const itemXml = (it) => it.kind === 'subtitle'
        ? `<subtitle>${escXml(it.text)}</subtitle>`
        : `<p>${escXml(it.text)}</p>`;
    const sectionToXml = (sec) => {
        const title = sec.title.length
            ? `\n<title>${sec.title.map(t => `<p>${escXml(t)}</p>`).join('')}</title>` : '';
        if (!sec.children.length) return `<section>${title}\n${sec.items.map(itemXml).join('\n')}\n</section>`;
        // Paragraphs between a part's title and its first chapter — an epigraph,
        // a date line — go first, in an untitled section: FB2 lets a section
        // hold paragraphs or subsections, not both.
        const lead = sec.items.length ? `\n<section>\n${sec.items.map(itemXml).join('\n')}\n</section>` : '';
        return `<section>${title}${lead}\n${sec.children.map(sectionToXml).join('\n')}\n</section>`;
    };
    const top = [];
    if (root.items.length) top.push(`<section>\n${root.items.map(itemXml).join('\n')}\n</section>`);
    for (const sec of root.children) top.push(sectionToXml(sec));
    if (!top.length) top.push('<section>\n\n</section>');
    const sectionXml = top.join('\n');

    const title = meta.title || 'Без названия';
    const lang = langCode(meta.langSuffix);
    const now = new Date();
    const date = now.toISOString().slice(0, 10);

    const cover = meta.cover && meta.cover.base64 ? meta.cover : null;
    const coverExt = cover ? (cover.mime === 'image/png' ? 'png' : 'jpg') : null;
    const coverTag = cover ? `\n<coverpage><image l:href="#cover.${coverExt}"/></coverpage>` : '';
    // base64 в binary принято переносить по строкам, чтобы читалки не давились
    const coverBinary = cover
        ? `\n<binary id="cover.${coverExt}" content-type="${escXml(cover.mime)}">${cover.base64.replace(/(.{76})/g, '$1\n')}</binary>`
        : '';

    // The reader's blurb goes first, the prozetta lines after it, separated by a
    // blank line so the two do not read as one paragraph run.
    const blurb = String(meta.annotation || '')
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .map(l => `<p>${escXml(l)}</p>`)
        .join('');
    const annotation =
        `<annotation>` +
        (blurb ? blurb + `<empty-line/>` : '') +
        `<p>Перевод сделан проектом prozetta — помощник переводчика.</p>` +
        `<p>Модель: ${escXml(meta.modelName || '—')}.</p>` +
        `<p>GitHub: https://github.com/UrgenProchnoff/prozetta</p>` +
        `</annotation>`;

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<FictionBook xmlns="http://www.gramota.ru/FictionBook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description>
<title-info>
<genre>prose_contemporary</genre>
${authorXml(meta.author)}
<book-title>${escXml(title)}</book-title>
${annotation}
<lang>${escXml(lang)}</lang>${coverTag}
</title-info>
<document-info>
<author><nickname>prozetta</nickname></author>
<program-used>prozetta</program-used>
<date value="${date}">${date}</date>
<id>${bookUuid(title + '|' + (meta.author || '') + '|' + lang)}</id>
<version>1.0</version>
</document-info>
</description>
<body>
<title><p>${escXml(title)}</p></title>
${sectionXml}
</body>${coverBinary}
</FictionBook>
`;

    return { xml, missing, sections: count || top.length };
}
