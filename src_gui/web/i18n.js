/* prozetta GUI — интернационализация интерфейса.
 *
 * Чтобы ДОБАВИТЬ ЯЗЫК: впишите его в LANG_META (название + локаль дат) и
 * добавьте словарь с теми же ключами в MESSAGES. Переключатель языка и весь
 * интерфейс подхватят его автоматически — менять app.js не нужно.
 *
 * Использование: t('ключ') или t('ключ', { name: value }) с подстановкой {name}.
 */
(function () {
    const DEFAULT_LANG = 'ru';
    const STORAGE_KEY = 'prozetta.lang';

    const LANG_META = {
        ru: { name: 'Русский', dateLocale: 'ru-RU' },
        en: { name: 'English', dateLocale: 'en-GB' },
    };

    const MESSAGES = {
        ru: {
            'common.loading': 'Загрузка…',
            'common.error': 'Ошибка: {msg}',
            'common.save': '💾 Сохранить',

            'header.lang': 'Язык / Language',

            'nav.projects': 'Проекты',

            'status.success': 'принято',
            'status.best_effort': 'лучшая попытка',
            'status.in_progress': 'в работе',
            'status.pending': 'в очереди',

            'dash.stateReadError': 'Ошибка чтения состояния: {msg}',
            'dash.running': '⚡ выполняется',
            'dash.meta': 'Обновлён: {date} · Чанков: {chunks} · Глоссарий: {glossary}',
            'dash.extracted': 'извлечено: {done}/{total}',
            'dash.monitor': 'Монитор',
            'dash.glossary': 'Глоссарий',
            'dash.download': '⬇ Перевод',
            'dash.noProjects': 'Проектов пока нет.',
            'dash.newBooks': 'Новые книги в txt/',
            'dash.notCreated': '{file} — проект ещё не создан',
            'dash.openMonitor': 'Открыть монитор → Этап 1',

            'gloss.heading': 'Глоссарий',
            'gloss.search': 'Поиск…',
            'gloss.addTerm': '+ Термин',
            'gloss.junkHint': '0 вхождений — мусор?',
            'gloss.junkHintTitle': 'Сколько чанков содержит термин. 0 — кандидат на удаление',
            'gloss.unsaved': 'несохранённые изменения',
            'gloss.colOriginal': 'Оригинал',
            'gloss.colTranslation': 'Перевод',
            'gloss.colType': 'Тип',
            'gloss.colGender': 'Род',
            'gloss.colNotes': 'Заметки',
            'gloss.colCountTitle': 'Вхождений в чанках',
            'gloss.delTitle': 'Удалить',
            'gloss.genderNone': '—',
            'gloss.genderM': 'м',
            'gloss.genderF': 'ж',
            'gloss.genderN': 'ср',
            'gloss.saved': 'Глоссарий сохранён ({count} терминов)',
            'gloss.saveError': 'Ошибка сохранения: {msg}',
            'gloss.leaveConfirm': 'Есть несохранённые изменения глоссария. Уйти без сохранения?',

            'mon.heading': 'Монитор',
            'mon.stageLabel': 'Этап',
            'mon.stage1': '1 — извлечение терминов',
            'mon.stage2': '2 — перевод',
            'mon.stageExport': 'экспорт',
            'mon.modelLabel': 'Модель',
            'mon.modelDefault': 'по умолчанию (local)',
            'mon.start': '▶ Старт',
            'mon.stop': '■ Стоп',
            'mon.running': '⚡ выполняется',
            'mon.stopped': 'остановлен',
            'legend.extracted': 'термины извлечены',
            'mon.gridEmpty': 'Проект ещё не создан — запустите Этап 1.',
            'mon.recommendPrefix': '▶ Рекомендуется: {text}',
            'mon.recommendedTag': '★ {base} (рекомендуется)',
            'rec.notCreated': 'Проект ещё не создан. Начните с Этапа 1 — извлечения терминов.',
            'rec.stage1Incomplete': 'Этап 1 не завершён: извлечено {done}/{total} чанков. Сначала закончите извлечение.',
            'rec.allDone': 'Все чанки переведены. Можно собрать книгу (экспорт) или открыть чанк для ручной правки.',
            'rec.glossaryEmpty': 'Термины извлечены, но глоссарий пуст. Проверьте/заполните глоссарий перед переводом.',
            'rec.canTranslate': 'Термины извлечены, глоссарий: {glossary} терминов. Можно запускать Этап 2. Не забудьте вычитать глоссарий.',
            'pre.notCreated': 'Проект ещё не создан, Этап 1 (извлечение терминов) не выполнялся.\n\nБез глоссария перевод потеряет единообразие имён и терминов. Рекомендуется сначала запустить Этап 1.\n\nВсё равно запустить перевод?',
            'pre.stage1Incomplete': 'Извлечение терминов завершено не полностью: {done}/{total} чанков.\n\nРекомендуемый порядок: сначала завершить Этап 1, вычитать глоссарий, затем переводить.\n\nВсё равно запустить перевод?',
            'pre.glossaryEmpty': 'Глоссарий пуст или отсутствует.\n\nПеревод пойдёт без шпаргалки имён и терминов — единообразие не гарантируется. Обычно глоссарий заполняется на Этапе 1 и вычитывается вручную.\n\nВсё равно запустить перевод?',
            'mon.stageStarted': 'Этап {stage} запущен',
            'mon.stopConfirm': 'Остановить процесс? Прогресс по завершённым чанкам сохранён.',
            'mon.processFinished': '[GUI] Процесс завершён (код {code})',
            'mon.chunkTitle': 'Чанк {n} · {status}',
            'mon.chunkTerms': 'Термины: {value}',
            'mon.chunkTermsYes': 'извлечено ({n})',
            'mon.chunkTermsYesNoCount': 'извлечено',
            'mon.chunkTermsNo': 'не извлечено',
            'mon.chunkScore': ' · оценка {score}',
            'mon.chunkSteps': ' · шагов: {n}',

            'chunk.crumb': 'Чанк {n}',
            'chunk.heading': 'Чанк {i} / {total}',
            'chunk.tokens': '{n} токенов',
            'chunk.termsExtracted': '🔍 термины: {n}',
            'chunk.termsNot': '○ термины не извлечены',
            'chunk.termsTitle': 'Этап 1: извлечение терминов',
            'chunk.toggleTitle': 'Скрыть/показать панель оригинала',
            'chunk.fontSmaller': 'Меньше шрифт',
            'chunk.fontLarger': 'Больше шрифт',
            'chunk.fontResetTitle': 'Размер шрифта: {size}px (клик — сброс)',
            'chunk.showOriginal': '◧ Показать оригинал',
            'chunk.hideOriginal': '◧ Скрыть оригинал',
            'chunk.approve': '✓ Сохранить и принять',
            'chunk.reset': '↺ Сбросить чанк',
            'chunk.original': 'Оригинал',
            'chunk.translationEditable': 'Перевод (редактируемый)',
            'chunk.history': 'История ({n})',
            'chunk.historyEmpty': 'История пуста — чанк ещё не переводился.',
            'chunk.editorLabel': 'Редактор: {comment}',
            'chunk.translatorLabel': 'Переводчик: {comment}',
            'chunk.scorePill': 'оценка: {v}',
            'chunk.likePill': 'like: {v}',
            'chunk.errPill': 'err: {v}',
            'chunk.saved': 'Сохранено',
            'chunk.savedApproved': 'Сохранено и принято',
            'chunk.resetConfirm': 'Сбросить чанк? Перевод и вся история попыток будут удалены, Этап 2 переведёт его заново.',
            'chunk.resetDone': 'Чанк сброшен',
        },

        en: {
            'common.loading': 'Loading…',
            'common.error': 'Error: {msg}',
            'common.save': '💾 Save',

            'header.lang': 'Язык / Language',

            'nav.projects': 'Projects',

            'status.success': 'approved',
            'status.best_effort': 'best effort',
            'status.in_progress': 'in progress',
            'status.pending': 'queued',

            'dash.stateReadError': 'State read error: {msg}',
            'dash.running': '⚡ running',
            'dash.meta': 'Updated: {date} · Chunks: {chunks} · Glossary: {glossary}',
            'dash.extracted': 'extracted: {done}/{total}',
            'dash.monitor': 'Monitor',
            'dash.glossary': 'Glossary',
            'dash.download': '⬇ Translation',
            'dash.noProjects': 'No projects yet.',
            'dash.newBooks': 'New books in txt/',
            'dash.notCreated': '{file} — project not created yet',
            'dash.openMonitor': 'Open monitor → Stage 1',

            'gloss.heading': 'Glossary',
            'gloss.search': 'Search…',
            'gloss.addTerm': '+ Term',
            'gloss.junkHint': '0 occurrences — junk?',
            'gloss.junkHintTitle': 'How many chunks contain the term. 0 — candidate for removal',
            'gloss.unsaved': 'unsaved changes',
            'gloss.colOriginal': 'Original',
            'gloss.colTranslation': 'Translation',
            'gloss.colType': 'Type',
            'gloss.colGender': 'Gender',
            'gloss.colNotes': 'Notes',
            'gloss.colCountTitle': 'Occurrences in chunks',
            'gloss.delTitle': 'Delete',
            'gloss.genderNone': '—',
            'gloss.genderM': 'm',
            'gloss.genderF': 'f',
            'gloss.genderN': 'n',
            'gloss.saved': 'Glossary saved ({count} terms)',
            'gloss.saveError': 'Save error: {msg}',
            'gloss.leaveConfirm': 'You have unsaved glossary changes. Leave without saving?',

            'mon.heading': 'Monitor',
            'mon.stageLabel': 'Stage',
            'mon.stage1': '1 — term extraction',
            'mon.stage2': '2 — translation',
            'mon.stageExport': 'export',
            'mon.modelLabel': 'Model',
            'mon.modelDefault': 'default (local)',
            'mon.start': '▶ Start',
            'mon.stop': '■ Stop',
            'mon.running': '⚡ running',
            'mon.stopped': 'stopped',
            'legend.extracted': 'terms extracted',
            'mon.gridEmpty': 'Project not created — run Stage 1.',
            'mon.recommendPrefix': '▶ Recommended: {text}',
            'mon.recommendedTag': '★ {base} (recommended)',
            'rec.notCreated': 'Project not created. Start with Stage 1 — term extraction.',
            'rec.stage1Incomplete': 'Stage 1 not finished: {done}/{total} chunks extracted. Finish extraction first.',
            'rec.allDone': 'All chunks translated. Assemble the book (export) or open a chunk for manual editing.',
            'rec.glossaryEmpty': 'Terms extracted, but the glossary is empty. Review/fill the glossary before translating.',
            'rec.canTranslate': 'Terms extracted, glossary: {glossary} terms. You can run Stage 2. Don\'t forget to proofread the glossary.',
            'pre.notCreated': 'Project not created, Stage 1 (term extraction) has not been run.\n\nWithout a glossary the translation will lose consistency of names and terms. It is recommended to run Stage 1 first.\n\nRun translation anyway?',
            'pre.stage1Incomplete': 'Term extraction is incomplete: {done}/{total} chunks.\n\nRecommended order: finish Stage 1, proofread the glossary, then translate.\n\nRun translation anyway?',
            'pre.glossaryEmpty': 'The glossary is empty or missing.\n\nTranslation will proceed without the names/terms cheat-sheet — consistency is not guaranteed. The glossary is usually built in Stage 1 and proofread manually.\n\nRun translation anyway?',
            'mon.stageStarted': 'Stage {stage} started',
            'mon.stopConfirm': 'Stop the process? Progress on finished chunks is saved.',
            'mon.processFinished': '[GUI] Process finished (code {code})',
            'mon.chunkTitle': 'Chunk {n} · {status}',
            'mon.chunkTerms': 'Terms: {value}',
            'mon.chunkTermsYes': 'extracted ({n})',
            'mon.chunkTermsYesNoCount': 'extracted',
            'mon.chunkTermsNo': 'not extracted',
            'mon.chunkScore': ' · score {score}',
            'mon.chunkSteps': ' · steps: {n}',

            'chunk.crumb': 'Chunk {n}',
            'chunk.heading': 'Chunk {i} / {total}',
            'chunk.tokens': '{n} tokens',
            'chunk.termsExtracted': '🔍 terms: {n}',
            'chunk.termsNot': '○ terms not extracted',
            'chunk.termsTitle': 'Stage 1: term extraction',
            'chunk.toggleTitle': 'Hide/show the original panel',
            'chunk.fontSmaller': 'Smaller font',
            'chunk.fontLarger': 'Larger font',
            'chunk.fontResetTitle': 'Font size: {size}px (click to reset)',
            'chunk.showOriginal': '◧ Show original',
            'chunk.hideOriginal': '◧ Hide original',
            'chunk.approve': '✓ Save and approve',
            'chunk.reset': '↺ Reset chunk',
            'chunk.original': 'Original',
            'chunk.translationEditable': 'Translation (editable)',
            'chunk.history': 'History ({n})',
            'chunk.historyEmpty': 'History is empty — the chunk has not been translated yet.',
            'chunk.editorLabel': 'Editor: {comment}',
            'chunk.translatorLabel': 'Translator: {comment}',
            'chunk.scorePill': 'score: {v}',
            'chunk.likePill': 'like: {v}',
            'chunk.errPill': 'err: {v}',
            'chunk.saved': 'Saved',
            'chunk.savedApproved': 'Saved and approved',
            'chunk.resetConfirm': 'Reset chunk? The translation and all attempt history will be deleted; Stage 2 will translate it again.',
            'chunk.resetDone': 'Chunk reset',
        },
    };

    function getLang() {
        const l = localStorage.getItem(STORAGE_KEY);
        return (l && MESSAGES[l]) ? l : DEFAULT_LANG;
    }

    function setLang(code) {
        if (!MESSAGES[code]) return;
        localStorage.setItem(STORAGE_KEY, code);
        document.documentElement.lang = code;
    }

    function t(key, params) {
        const lang = getLang();
        let s = MESSAGES[lang] && MESSAGES[lang][key];
        if (s === undefined) s = MESSAGES[DEFAULT_LANG][key];
        if (s === undefined) return key; // missing key — surface it rather than blank
        if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined ? params[k] : m));
        return s;
    }

    function dateLocale() {
        return (LANG_META[getLang()] || {}).dateLocale || 'ru-RU';
    }

    // Initialise <html lang> on load
    document.documentElement.lang = getLang();

    window.i18n = { t, getLang, setLang, dateLocale, langs: LANG_META };
    window.t = t; // convenience global used throughout app.js
})();
