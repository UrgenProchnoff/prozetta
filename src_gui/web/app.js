/* Translator V4 GUI — single-file SPA, no build step */

const app = document.getElementById('app');
const breadcrumbs = document.getElementById('breadcrumbs');

// --- Helpers ---

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(url, opts = {}) {
    if (opts.body !== undefined) {
        opts.headers = { 'Content-Type': 'application/json', ...opts.headers };
        opts.body = JSON.stringify(opts.body);
    }
    const r = await fetch(url, opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
}

function toast(msg, kind = '') {
    const el = document.createElement('div');
    el.className = `t ${kind}`;
    el.textContent = msg;
    document.getElementById('toast').appendChild(el);
    setTimeout(() => el.remove(), 4000);
}

function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const STATUS_LABELS = {
    success: 'принято',
    best_effort: 'лучшая попытка',
    in_progress: 'в работе',
    pending: 'в очереди'
};

// --- Router ---

let cleanup = null; // page teardown (close SSE etc.)

function route() {
    if (cleanup) { cleanup(); cleanup = null; }
    const hash = location.hash.replace(/^#/, '') || '/';
    const parts = hash.split('/').filter(Boolean);

    if (parts.length === 0) return renderDashboard();
    if (parts[0] === 'glossary' && parts[1]) return renderGlossary(decodeURIComponent(parts[1]));
    if (parts[0] === 'monitor' && parts[1]) return renderMonitor(decodeURIComponent(parts[1]));
    if (parts[0] === 'chunk' && parts[1] && parts[2] !== undefined)
        return renderChunk(decodeURIComponent(parts[1]), parseInt(parts[2], 10));
    renderDashboard();
}

window.addEventListener('hashchange', route);

function setCrumbs(html) { breadcrumbs.innerHTML = html; }

// ============================================================
// Dashboard
// ============================================================

async function renderDashboard() {
    setCrumbs('Проекты');
    app.innerHTML = '<div class="loading">Загрузка…</div>';

    let data;
    try { data = await api('/api/projects'); }
    catch (e) { app.innerHTML = `<div class="loading">Ошибка: ${esc(e.message)}</div>`; return; }

    const projectCards = data.projects.map(p => {
        if (p.error) {
            return `<div class="card"><div class="title">${esc(p.prefix)}</div>
                <div class="meta">Ошибка чтения состояния: ${esc(p.error)}</div></div>`;
        }
        const t = p.total || 1;
        const pct = s => (100 * (p.statuses[s] || 0) / t).toFixed(1);
        const done = p.statuses.success + p.statuses.best_effort;
        return `
        <div class="card">
            <div class="title">${esc(p.prefix)}
                ${p.running ? '<span class="badge b-running">⚡ выполняется</span>' : ''}
            </div>
            <div class="meta">Обновлён: ${fmtDate(p.metadata.updatedAt)} · Чанков: ${p.total} · Глоссарий: ${p.glossaryCount ?? '—'}</div>
            <div class="progress">
                <div class="p-success" style="width:${pct('success')}%"></div>
                <div class="p-best_effort" style="width:${pct('best_effort')}%"></div>
                <div class="p-in_progress" style="width:${pct('in_progress')}%"></div>
            </div>
            <div class="badges">
                <span class="badge b-success">✓ ${p.statuses.success}</span>
                <span class="badge b-best_effort">~ ${p.statuses.best_effort}</span>
                <span class="badge">⏳ ${p.statuses.pending + p.statuses.in_progress}</span>
                <span class="badge">извлечено: ${p.extracted}/${p.total}</span>
            </div>
            <div class="row">
                <a class="btn" href="#/monitor/${encodeURIComponent(p.prefix)}">Монитор</a>
                <a class="btn" href="#/glossary/${encodeURIComponent(p.prefix)}">Глоссарий</a>
                ${done > 0 ? `<a class="btn" href="/api/projects/${encodeURIComponent(p.prefix)}/output">⬇ Перевод</a>` : ''}
            </div>
        </div>`;
    }).join('');

    const newBookCards = data.newBooks.map(b => `
        <div class="card">
            <div class="title">📄 ${esc(b.prefix)}</div>
            <div class="meta">${esc(b.file)} — проект ещё не создан</div>
            <div class="row">
                <a class="btn primary" href="#/monitor/${encodeURIComponent(b.prefix)}">Открыть монитор → Этап 1</a>
            </div>
        </div>`).join('');

    app.innerHTML = `
        <h2>Проекты</h2>
        ${projectCards ? `<div class="cards">${projectCards}</div>` : '<p class="loading">Проектов пока нет.</p>'}
        ${newBookCards ? `<h3>Новые книги в txt/</h3><div class="cards">${newBookCards}</div>` : ''}
    `;
}

// ============================================================
// Glossary editor
// ============================================================

async function renderGlossary(prefix) {
    setCrumbs(`<a href="#/">Проекты</a> / ${esc(prefix)} / Глоссарий`);
    app.innerHTML = '<div class="loading">Загрузка…</div>';

    let terms, counts;
    try {
        const data = await api(`/api/projects/${encodeURIComponent(prefix)}/glossary`);
        terms = data.terms;
        counts = data.counts;
    } catch (e) {
        app.innerHTML = `<div class="loading">Ошибка: ${esc(e.message)}</div>`;
        return;
    }

    let dirty = false;
    let filter = '';

    const knownTypes = [...new Set(['name', 'term', ...terms.map(t => t.type).filter(Boolean)])];

    app.innerHTML = `
        <h2>Глоссарий: ${esc(prefix)}</h2>
        <div class="toolbar">
            <input id="g-search" type="search" placeholder="Поиск…" style="width:220px">
            <button id="g-add">+ Термин</button>
            <span id="g-count" class="badge"></span>
            <span class="badge" title="Сколько чанков содержит термин. 0 — кандидат на удаление">0 вхождений — мусор?</span>
            <span class="spacer"></span>
            <span id="g-dirty" class="dirty" hidden>несохранённые изменения</span>
            <button id="g-save" class="primary">💾 Сохранить</button>
        </div>
        <table class="glossary">
            <thead><tr>
                <th style="width:22%">Оригинал</th>
                <th style="width:22%">Перевод</th>
                <th style="width:10%">Тип</th>
                <th style="width:8%">Род</th>
                <th>Заметки</th>
                <th style="width:60px" title="Вхождений в чанках">#</th>
                <th style="width:40px"></th>
            </tr></thead>
            <tbody id="g-body"></tbody>
        </table>
    `;

    const tbody = document.getElementById('g-body');
    const dirtyEl = document.getElementById('g-dirty');
    const countEl = document.getElementById('g-count');

    function markDirty() { dirty = true; dirtyEl.hidden = false; }

    function renderRows() {
        const q = filter.toLowerCase();
        const rows = terms.map((t, idx) => ({ t, idx }))
            .filter(({ t }) => !q
                || (t.original || '').toLowerCase().includes(q)
                || (t.translation || '').toLowerCase().includes(q)
                || (t.notes || '').toLowerCase().includes(q));

        countEl.textContent = `${rows.length} / ${terms.length}`;

        tbody.innerHTML = rows.map(({ t, idx }) => {
            const cnt = counts[idx];
            const typeOpts = knownTypes.map(k =>
                `<option value="${esc(k)}" ${t.type === k ? 'selected' : ''}>${esc(k)}</option>`).join('');
            return `<tr data-idx="${idx}">
                <td><input data-f="original" value="${esc(t.original)}"></td>
                <td><input data-f="translation" value="${esc(t.translation)}"></td>
                <td><select data-f="type">${typeOpts}</select></td>
                <td><select data-f="gender">
                    <option value="" ${!t.gender ? 'selected' : ''}>—</option>
                    <option value="m" ${t.gender === 'm' ? 'selected' : ''}>м</option>
                    <option value="f" ${t.gender === 'f' ? 'selected' : ''}>ж</option>
                    <option value="n" ${t.gender === 'n' ? 'selected' : ''}>ср</option>
                </select></td>
                <td><input data-f="notes" value="${esc(t.notes)}"></td>
                <td class="cnt ${cnt === 0 ? 'zero' : ''}">${cnt ?? ''}</td>
                <td class="del"><button class="danger" data-del="${idx}" title="Удалить">✕</button></td>
            </tr>`;
        }).join('');
    }

    tbody.addEventListener('input', (e) => {
        const tr = e.target.closest('tr');
        const f = e.target.dataset.f;
        if (!tr || !f) return;
        const t = terms[+tr.dataset.idx];
        t[f] = f === 'gender' && e.target.value === '' ? null : e.target.value;
        markDirty();
    });

    tbody.addEventListener('click', (e) => {
        const del = e.target.dataset.del;
        if (del === undefined) return;
        terms.splice(+del, 1);
        counts.splice(+del, 1);
        markDirty();
        renderRows();
    });

    document.getElementById('g-search').addEventListener('input', (e) => {
        filter = e.target.value;
        renderRows();
    });

    document.getElementById('g-add').addEventListener('click', () => {
        terms.unshift({ original: '', translation: '', type: 'name', gender: null, notes: '' });
        counts.unshift(null);
        markDirty();
        renderRows();
        tbody.querySelector('input')?.focus();
    });

    document.getElementById('g-save').addEventListener('click', async () => {
        const cleaned = terms.filter(t => (t.original || '').trim());
        try {
            const r = await api(`/api/projects/${encodeURIComponent(prefix)}/glossary`, { method: 'PUT', body: cleaned });
            dirty = false;
            dirtyEl.hidden = true;
            toast(`Глоссарий сохранён (${r.count} терминов)`, 'ok');
        } catch (e) {
            toast(`Ошибка сохранения: ${e.message}`, 'error');
        }
    });

    renderRows();

    cleanup = () => {
        if (dirty && !confirm('Есть несохранённые изменения глоссария. Уйти без сохранения?')) {
            // too late to cancel hash navigation cleanly — just warn
        }
    };
}

// ============================================================
// Monitor
// ============================================================

async function renderMonitor(prefix) {
    setCrumbs(`<a href="#/">Проекты</a> / ${esc(prefix)} / Монитор`);

    app.innerHTML = `
        <h2>Монитор: ${esc(prefix)}</h2>
        <div class="toolbar">
            <label>Этап
                <select id="m-stage">
                    <option value="1" data-base="1 — извлечение терминов">1 — извлечение терминов</option>
                    <option value="2" data-base="2 — перевод">2 — перевод</option>
                    <option value="export" data-base="экспорт">экспорт</option>
                </select>
            </label>
            <label>Модель
                <select id="m-model">
                    <option value="default">по умолчанию (local)</option>
                    <option value="local">local</option>
                    <option value="google">google</option>
                    <option value="groq">groq</option>
                </select>
            </label>
            <button id="m-start" class="primary">▶ Старт</button>
            <button id="m-stop" class="danger" disabled>■ Стоп</button>
            <span class="spacer"></span>
            <span id="m-status" class="badge"></span>
            <a class="btn" href="#/glossary/${encodeURIComponent(prefix)}">Глоссарий</a>
            <a class="btn" href="/api/projects/${encodeURIComponent(prefix)}/output">⬇ Перевод</a>
        </div>
        <div id="m-hint" class="hint" hidden></div>
        <div class="monitor-grid">
            <div>
                <div class="legend">
                    <span><span class="dot" style="background:#1e5e41"></span>принято</span>
                    <span><span class="dot" style="background:#6b5320"></span>лучшая попытка</span>
                    <span><span class="dot" style="background:#29456e"></span>в работе</span>
                    <span><span class="dot" style="background:#1f242e"></span>в очереди</span>
                    <span><span class="dot ext-dot"></span>термины извлечены</span>
                </div>
                <div id="m-grid" class="chunk-grid"><span class="loading">Загрузка…</span></div>
            </div>
            <div>
                <div id="m-log" class="log-pane"></div>
            </div>
        </div>
    `;

    const grid = document.getElementById('m-grid');
    const logPane = document.getElementById('m-log');
    const statusEl = document.getElementById('m-status');
    const startBtn = document.getElementById('m-start');
    const stopBtn = document.getElementById('m-stop');
    const stageSel = document.getElementById('m-stage');
    const hintEl = document.getElementById('m-hint');

    let activeChunk = null; // 0-based index parsed from the log
    let running = false;
    let recommendApplied = false; // preselect the stage only once, then respect user choice

    // Where is the project in the pipeline? Drives the recommended next stage.
    function recommend(s) {
        if (!s || s.total === 0)
            return { stage: '1', text: 'Проект ещё не создан. Начните с Этапа 1 — извлечения терминов.' };
        if (s.extracted < s.total)
            return { stage: '1', text: `Этап 1 не завершён: извлечено ${s.extracted}/${s.total} чанков. Сначала закончите извлечение.` };
        const done = s.statuses.success + s.statuses.best_effort;
        if (done >= s.total)
            return { stage: 'export', text: 'Все чанки переведены. Можно собрать книгу (экспорт) или открыть чанк для ручной правки.' };
        if (!s.glossaryCount)
            return { stage: '2', text: 'Термины извлечены, но глоссарий пуст. Проверьте/заполните глоссарий перед переводом.' };
        return { stage: '2', text: `Термины извлечены, глоссарий: ${s.glossaryCount} терминов. Можно запускать Этап 2. Не забудьте вычитать глоссарий.` };
    }

    // Returns a warning string if the chosen stage breaks the recommended order
    // (extraction → review glossary → translation), or null if it's safe.
    function preflight(stage, s) {
        if (stage !== '2') return null;
        if (!s || s.total === 0)
            return 'Проект ещё не создан, Этап 1 (извлечение терминов) не выполнялся.\n\nБез глоссария перевод потеряет единообразие имён и терминов. Рекомендуется сначала запустить Этап 1.\n\nВсё равно запустить перевод?';
        if (s.extracted < s.total)
            return `Извлечение терминов завершено не полностью: ${s.extracted}/${s.total} чанков.\n\nРекомендуемый порядок: сначала завершить Этап 1, вычитать глоссарий, затем переводить.\n\nВсё равно запустить перевод?`;
        if (!s.glossaryCount)
            return 'Глоссарий пуст или отсутствует.\n\nПеревод пойдёт без шпаргалки имён и терминов — единообразие не гарантируется. Обычно глоссарий заполняется на Этапе 1 и вычитывается вручную.\n\nВсё равно запустить перевод?';
        return null;
    }

    function applyRecommendation() {
        const rec = recommend(summary);
        // Annotate the recommended option and (once) preselect it
        for (const opt of stageSel.options) {
            const base = opt.dataset.base || opt.textContent;
            opt.textContent = opt.value === rec.stage ? `★ ${base} (рекомендуется)` : base;
        }
        if (!recommendApplied && !running) {
            stageSel.value = rec.stage;
            recommendApplied = true;
        }
        hintEl.hidden = false;
        hintEl.textContent = `▶ Рекомендуется: ${rec.text}`;
    }

    function setRunning(v) {
        running = v;
        startBtn.disabled = v;
        stopBtn.disabled = !v;
        statusEl.textContent = v ? '⚡ выполняется' : 'остановлен';
        statusEl.className = `badge ${v ? 'b-running' : ''}`;
        if (!v) { activeChunk = null; }
    }

    function appendLog(line) {
        const div = document.createElement('div');
        let cls = '';
        if (/error|fatal/i.test(line)) cls = 'err';
        else if (/warn|rejected|missing|failed/i.test(line)) cls = 'warn';
        else if (/approved|complete|saved/i.test(line)) cls = 'ok';
        div.className = cls;
        div.textContent = line;
        const atBottom = logPane.scrollTop + logPane.clientHeight >= logPane.scrollHeight - 40;
        logPane.appendChild(div);
        while (logPane.childNodes.length > 1000) logPane.removeChild(logPane.firstChild);
        if (atBottom) logPane.scrollTop = logPane.scrollHeight;

        const m = line.match(/Processing Chunk (\d+)\/\d+/);
        if (m) { activeChunk = parseInt(m[1], 10) - 1; refreshGrid(); }
    }

    let summary = null;
    function drawGrid() {
        if (!summary) {
            grid.innerHTML = '<span class="loading">Проект ещё не создан — запустите Этап 1.</span>';
            return;
        }
        grid.innerHTML = summary.chunks.map(c => {
            const title = `Чанк ${c.i + 1} · ${STATUS_LABELS[c.status]}`
                + `\nТермины: ${c.extracted ? (c.nTerms != null ? `извлечено (${c.nTerms})` : 'извлечено') : 'не извлечено'}`
                + (c.score != null ? ` · оценка ${c.score}` : '')
                + (c.attempts ? ` · шагов: ${c.attempts}` : '')
                + `\n${c.preview}`;
            return `<a class="chunk-cell s-${c.status} ${c.extracted ? 'extracted' : ''} ${c.i === activeChunk && running ? 'active' : ''}"
                href="#/chunk/${encodeURIComponent(prefix)}/${c.i}" title="${esc(title)}">${c.i + 1}</a>`;
        }).join('');
    }

    let refreshTimer = null;
    function refreshGrid() {
        if (refreshTimer) return;
        refreshTimer = setTimeout(async () => {
            refreshTimer = null;
            try {
                summary = await api(`/api/projects/${encodeURIComponent(prefix)}/summary`);
            } catch { summary = null; }
            drawGrid();
            applyRecommendation();
        }, 300);
    }

    // Initial load: summary + job backlog
    try { summary = await api(`/api/projects/${encodeURIComponent(prefix)}/summary`); } catch { summary = null; }
    drawGrid();
    applyRecommendation();

    try {
        const job = await api(`/api/projects/${encodeURIComponent(prefix)}/job`);
        for (const line of job.log) appendLog(line);
        setRunning(job.running);
    } catch { setRunning(false); }

    // Live events
    const es = new EventSource(`/api/projects/${encodeURIComponent(prefix)}/events`);
    es.addEventListener('log', (e) => appendLog(JSON.parse(e.data)));
    es.addEventListener('state', () => refreshGrid());
    es.addEventListener('job', (e) => {
        const j = JSON.parse(e.data);
        setRunning(!!j.running);
        if (j.running === false && j.exitCode !== undefined) {
            appendLog(`[GUI] Процесс завершён (код ${j.exitCode})`);
            refreshGrid();
        }
    });

    startBtn.addEventListener('click', async () => {
        const stage = stageSel.value;
        const model = document.getElementById('m-model').value;

        const warning = preflight(stage, summary);
        if (warning && !confirm(warning)) return;

        try {
            await api('/api/run', { method: 'POST', body: { prefix, stage, model } });
            logPane.innerHTML = '';
            toast(`Этап ${stage} запущен`, 'ok');
        } catch (e) {
            toast(e.message, 'error');
        }
    });

    stopBtn.addEventListener('click', async () => {
        if (!confirm('Остановить процесс? Прогресс по завершённым чанкам сохранён.')) return;
        try { await api(`/api/projects/${encodeURIComponent(prefix)}/stop`, { method: 'POST' }); }
        catch (e) { toast(e.message, 'error'); }
    });

    cleanup = () => es.close();
}

// ============================================================
// Chunk view
// ============================================================

async function renderChunk(prefix, i) {
    setCrumbs(`<a href="#/">Проекты</a> / <a href="#/monitor/${encodeURIComponent(prefix)}">${esc(prefix)}</a> / Чанк ${i + 1}`);
    app.innerHTML = '<div class="loading">Загрузка…</div>';

    let data;
    try { data = await api(`/api/projects/${encodeURIComponent(prefix)}/chunks/${i}`); }
    catch (e) { app.innerHTML = `<div class="loading">Ошибка: ${esc(e.message)}</div>`; return; }

    const { chunk, total } = data;
    const status = chunk.translation_status === 'success' ? 'success'
        : chunk.translation_status === 'failed_best_effort' ? 'best_effort'
        : (chunk.history?.length ? 'in_progress' : 'pending');

    const extracted = chunk.extraction_status === 'success' || Array.isArray(chunk.extracted_terms);
    const nTerms = Array.isArray(chunk.extracted_terms) ? chunk.extracted_terms.length : null;

    const history = (chunk.history || []).slice().reverse();

    const historyHtml = history.map(h => {
        const stepType = h.step.startsWith('check') ? 'check'
            : h.step.startsWith('fix') ? 'fix'
            : h.step.startsWith('redraft') ? 'redraft' : 'draft';
        const r = h.result;
        const pills = r ? `
            <span class="score-pill">оценка: ${r.score ?? '?'}</span>
            <span class="score-pill">like: ${r.like ?? '?'}</span>
            <span class="score-pill">err: ${r.error ?? '?'}</span>` : '';
        const body = [
            r?.comment ? `Редактор: ${r.comment}` : '',
            h.translator_comment ? `Переводчик: ${h.translator_comment}` : ''
        ].filter(Boolean).join('\n');
        return `<details class="history-item">
            <summary>
                <span class="step ${stepType}">${esc(h.step)}</span>
                ${pills}
                <span class="ts">${fmtDate(h.timestamp)}</span>
            </summary>
            <div class="body">${body ? `<div class="comment">${esc(body)}</div>` : ''}${h.text ? `\n${esc(h.text)}` : ''}</div>
        </details>`;
    }).join('');

    app.innerHTML = `
        <div class="toolbar">
            <a class="btn" href="#/chunk/${encodeURIComponent(prefix)}/${i - 1}" ${i <= 0 ? 'hidden' : ''}>← ${i}</a>
            <h2 style="margin:0">Чанк ${i + 1} / ${total}</h2>
            <a class="btn" href="#/chunk/${encodeURIComponent(prefix)}/${i + 1}" ${i >= total - 1 ? 'hidden' : ''}>${i + 2} →</a>
            <span class="badge b-${status}">${STATUS_LABELS[status]}</span>
            <span class="badge">${chunk.tokens ?? '?'} токенов</span>
            <span class="badge" title="Этап 1: извлечение терминов">${extracted ? `🔍 термины: ${nTerms ?? '✓'}` : '○ термины не извлечены'}</span>
            <span class="spacer"></span>
            <button id="c-save">💾 Сохранить</button>
            <button id="c-approve" class="primary">✓ Сохранить и принять</button>
            <button id="c-reset" class="danger">↺ Сбросить чанк</button>
        </div>
        <div class="panes">
            <div class="pane">
                <h4>Оригинал</h4>
                <div class="original-text">${esc(chunk.original)}</div>
            </div>
            <div class="pane">
                <h4>Перевод (редактируемый)</h4>
                <textarea id="c-translation">${esc(chunk.translation || '')}</textarea>
            </div>
        </div>
        <h3>История (${history.length})</h3>
        ${historyHtml || '<p class="loading">История пуста — чанк ещё не переводился.</p>'}
    `;

    const ta = document.getElementById('c-translation');

    async function saveChunk(approve) {
        const body = { translation: ta.value };
        if (approve) body.translation_status = 'success';
        try {
            await api(`/api/projects/${encodeURIComponent(prefix)}/chunks/${i}`, { method: 'PUT', body });
            toast(approve ? 'Сохранено и принято' : 'Сохранено', 'ok');
            if (approve) renderChunk(prefix, i);
        } catch (e) {
            toast(e.message, 'error');
        }
    }

    document.getElementById('c-save').addEventListener('click', () => saveChunk(false));
    document.getElementById('c-approve').addEventListener('click', () => saveChunk(true));
    document.getElementById('c-reset').addEventListener('click', async () => {
        if (!confirm('Сбросить чанк? Перевод и вся история попыток будут удалены, Этап 2 переведёт его заново.')) return;
        try {
            await api(`/api/projects/${encodeURIComponent(prefix)}/chunks/${i}`, { method: 'PUT', body: { reset: true } });
            toast('Чанк сброшен', 'ok');
            renderChunk(prefix, i);
        } catch (e) {
            toast(e.message, 'error');
        }
    });
}

// --- Go ---
route();
