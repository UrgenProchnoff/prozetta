/* prozetta GUI — single-file SPA, no build step. UI strings via i18n (window.t). */

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
    return d.toLocaleString(i18n.dateLocale(), { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function statusLabel(s) { return t(`status.${s}`); }

// Compact token/number formatting: 1234 → "1.2k", 3_400_000 → "3.4M".
function fmtNum(n) {
    n = Number(n) || 0;
    if (n < 1000) return String(n);
    if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0) + 'k';
    return (n / 1e6).toFixed(n < 1e7 ? 2 : 1) + 'M';
}

// Localized labels for the per-operation usage breakdown.
function usageStageLabel(stage) {
    const key = `usage.stage.${stage}`;
    const label = t(key);
    return label === key ? stage : label;
}

// Render the full token-spend panel for the monitor view from metadata.usage.
function usagePanelHtml(usage) {
    if (!usage || !usage.totalCalls) {
        return `<div class="usage-panel empty">${esc(t('usage.none'))}</div>`;
    }
    const stages = Object.keys(usage.byStage || {})
        .map(k => ({ k, ...usage.byStage[k] }))
        .sort((a, b) => b.totalTokens - a.totalTokens);
    const models = Object.keys(usage.byModel || {})
        .map(k => ({ k, ...usage.byModel[k] }))
        .sort((a, b) => b.totalTokens - a.totalTokens);

    const stageRows = stages.map(s => `
        <tr><td>${esc(usageStageLabel(s.k))}</td><td>${fmtNum(s.calls)}</td>
        <td>${fmtNum(s.inputTokens)}</td><td>${fmtNum(s.outputTokens)}</td>
        <td>${fmtNum(s.totalTokens)}</td></tr>`).join('');
    const modelRows = models.map(m => `
        <tr><td>${esc(m.k)}</td><td>${fmtNum(m.calls)}</td>
        <td>${fmtNum(m.inputTokens)}</td><td>${fmtNum(m.outputTokens)}</td>
        <td>${fmtNum(m.totalTokens)}</td></tr>`).join('');

    return `
    <div class="usage-panel">
        <div class="usage-totals">
            <div class="usage-stat"><span class="num">${fmtNum(usage.totalCalls)}</span><span class="lbl">${esc(t('usage.calls'))}</span></div>
            <div class="usage-stat"><span class="num">${fmtNum(usage.inputTokens)}</span><span class="lbl">${esc(t('usage.input'))}</span></div>
            <div class="usage-stat"><span class="num">${fmtNum(usage.outputTokens)}</span><span class="lbl">${esc(t('usage.output'))}</span></div>
            <div class="usage-stat total"><span class="num">${fmtNum(usage.totalTokens)}</span><span class="lbl">${esc(t('usage.total'))}</span></div>
        </div>
        <table class="usage-table">
            <thead><tr><th>${esc(t('usage.byStage'))}</th><th>${esc(t('usage.calls'))}</th><th>${esc(t('usage.input'))}</th><th>${esc(t('usage.output'))}</th><th>${esc(t('usage.total'))}</th></tr></thead>
            <tbody>${stageRows}</tbody>
        </table>
        ${models.length ? `<table class="usage-table">
            <thead><tr><th>${esc(t('usage.byModel'))}</th><th>${esc(t('usage.calls'))}</th><th>${esc(t('usage.input'))}</th><th>${esc(t('usage.output'))}</th><th>${esc(t('usage.total'))}</th></tr></thead>
            <tbody>${modelRows}</tbody>
        </table>` : ''}
    </div>`;
}

// --- Router ---

let cleanup = null; // page teardown (close SSE etc.)

function route() {
    if (cleanup) { cleanup(); cleanup = null; }
    const hash = location.hash.replace(/^#/, '') || '/';
    const parts = hash.split('/').filter(Boolean);

    if (parts.length === 0) return renderDashboard();
    if (parts[0] === 'settings') return renderSettings();
    if (parts[0] === 'glossary' && parts[1]) return renderGlossary(decodeURIComponent(parts[1]));
    if (parts[0] === 'monitor' && parts[1]) return renderMonitor(decodeURIComponent(parts[1]));
    if (parts[0] === 'chunk' && parts[1] && parts[2] !== undefined)
        return renderChunk(decodeURIComponent(parts[1]), parseInt(parts[2], 10));
    renderDashboard();
}

window.addEventListener('hashchange', route);

function setCrumbs(html) { breadcrumbs.innerHTML = html; }
function crumbHome() { return `<a href="#/">${esc(t('nav.projects'))}</a>`; }

// ============================================================
// Dashboard
// ============================================================

async function renderDashboard() {
    setCrumbs(esc(t('nav.projects')));
    app.innerHTML = `<div class="loading">${esc(t('common.loading'))}</div>`;

    let data;
    try { data = await api('/api/projects'); }
    catch (e) { app.innerHTML = `<div class="loading">${esc(t('common.error', { msg: e.message }))}</div>`; return; }

    const projectCards = data.projects.map(p => {
        if (p.error) {
            return `<div class="card"><div class="title">${esc(p.prefix)}</div>
                <div class="meta">${esc(t('dash.stateReadError', { msg: p.error }))}</div></div>`;
        }
        const total = p.total || 1;
        const pct = s => (100 * (p.statuses[s] || 0) / total).toFixed(1);
        return `
        <div class="card">
            <div class="title">${esc(p.prefix)}
                ${p.running ? `<span class="badge b-running">${esc(t('dash.running'))}</span>` : ''}
            </div>
            <div class="meta">${esc(t('dash.meta', { date: fmtDate(p.metadata.updatedAt), chunks: p.total, glossary: p.glossaryCount ?? '—' }))}</div>
            <div class="progress">
                <div class="p-success" style="width:${pct('success')}%"></div>
                <div class="p-best_effort" style="width:${pct('best_effort')}%"></div>
                <div class="p-in_progress" style="width:${pct('in_progress')}%"></div>
            </div>
            <div class="badges">
                <span class="badge b-success">✓ ${p.statuses.success}</span>
                <span class="badge b-best_effort">~ ${p.statuses.best_effort}</span>
                <span class="badge">⏳ ${p.statuses.pending + p.statuses.in_progress}</span>
                <span class="badge">${esc(t('dash.extracted', { done: p.extracted, total: p.total }))}</span>
            </div>
            ${p.metadata?.usage?.totalCalls ? `<div class="meta usage-line" title="${esc(t('usage.cardTitle'))}">⚡ ${esc(t('usage.cardLine', { calls: fmtNum(p.metadata.usage.totalCalls), tokens: fmtNum(p.metadata.usage.totalTokens) }))}</div>` : ''}
            <div class="row">
                <a class="btn" href="#/monitor/${encodeURIComponent(p.prefix)}">${esc(t('dash.monitor'))}</a>
                <a class="btn" href="#/glossary/${encodeURIComponent(p.prefix)}">${esc(t('dash.glossary'))}</a>
                <button class="btn" data-clone="${esc(p.prefix)}">${esc(t('dash.cloneLang'))}</button>
                <button class="btn danger" data-delete="${esc(p.prefix)}">${esc(t('dash.delete'))}</button>
            </div>
        </div>`;
    }).join('');

    const newBookCards = data.newBooks.map(b => `
        <div class="card">
            <div class="title">📄 ${esc(b.prefix)}</div>
            <div class="meta">${esc(t('dash.notCreated', { file: b.file }))}</div>
            <div class="row">
                <a class="btn primary" href="#/monitor/${encodeURIComponent(b.prefix)}">${esc(t('dash.openMonitor'))}</a>
            </div>
        </div>`).join('');

    app.innerHTML = `
        <h2>${esc(t('nav.projects'))}</h2>
        ${projectCards ? `<div class="cards">${projectCards}</div>` : `<p class="loading">${esc(t('dash.noProjects'))}</p>`}
        ${newBookCards ? `<h3>${esc(t('dash.newBooks'))}</h3><div class="cards">${newBookCards}</div>` : ''}
    `;

    app.querySelectorAll('[data-clone]').forEach(btn => btn.addEventListener('click', async () => {
        const prefix = btn.dataset.clone;
        const language = prompt(t('dash.clonePromptLang'));
        if (!language || !language.trim()) return;
        const suffix = prompt(t('dash.clonePromptSuffix'));
        if (!suffix || !suffix.trim()) return;
        try {
            const r = await api(`/api/projects/${encodeURIComponent(prefix)}/clone`, {
                method: 'POST', body: { language: language.trim(), suffix: suffix.trim() }
            });
            toast(t('dash.cloneDone', { prefix: r.prefix }), 'ok');
            location.hash = `#/monitor/${encodeURIComponent(r.prefix)}`;
        } catch (err) {
            toast(err.message, 'error');
        }
    }));

    app.querySelectorAll('[data-delete]').forEach(btn => btn.addEventListener('click', async () => {
        const prefix = btn.dataset.delete;
        if (!confirm(t('dash.deleteConfirm', { prefix }))) return;
        try {
            await api(`/api/projects/${encodeURIComponent(prefix)}/delete`, { method: 'POST' });
            toast(t('dash.deleteDone', { prefix }), 'ok');
            renderDashboard();
        } catch (err) {
            toast(err.message, 'error');
        }
    }));
}

// ============================================================
// Glossary editor
// ============================================================

async function renderGlossary(prefix) {
    setCrumbs(`${crumbHome()} / ${esc(prefix)} / ${esc(t('gloss.heading'))}`);
    app.innerHTML = `<div class="loading">${esc(t('common.loading'))}</div>`;

    let terms, counts;
    try {
        const data = await api(`/api/projects/${encodeURIComponent(prefix)}/glossary`);
        terms = data.terms;
        counts = data.counts;
    } catch (e) {
        app.innerHTML = `<div class="loading">${esc(t('common.error', { msg: e.message }))}</div>`;
        return;
    }

    let dirty = false;
    let filter = '';

    const knownTypes = [...new Set(['name', 'term', ...terms.map(t => t.type).filter(Boolean)])];

    app.innerHTML = `
        <h2>${esc(t('gloss.heading'))}: ${esc(prefix)}</h2>
        <div class="toolbar">
            <input id="g-search" type="search" placeholder="${esc(t('gloss.search'))}" style="width:220px">
            <button id="g-add">${esc(t('gloss.addTerm'))}</button>
            <span id="g-count" class="badge"></span>
            <span class="badge" title="${esc(t('gloss.junkHintTitle'))}">${esc(t('gloss.junkHint'))}</span>
            <span class="spacer"></span>
            <span id="g-dirty" class="dirty" hidden>${esc(t('gloss.unsaved'))}</span>
            <button id="g-save" class="primary">${esc(t('common.save'))}</button>
        </div>
        <table class="glossary">
            <thead><tr>
                <th style="width:22%">${esc(t('gloss.colOriginal'))}</th>
                <th style="width:22%">${esc(t('gloss.colTranslation'))}</th>
                <th style="width:10%">${esc(t('gloss.colType'))}</th>
                <th style="width:8%">${esc(t('gloss.colGender'))}</th>
                <th>${esc(t('gloss.colNotes'))}</th>
                <th style="width:60px" title="${esc(t('gloss.colCountTitle'))}">#</th>
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

        tbody.innerHTML = rows.map(({ t: term, idx }) => {
            const cnt = counts[idx];
            const typeOpts = knownTypes.map(k =>
                `<option value="${esc(k)}" ${term.type === k ? 'selected' : ''}>${esc(k)}</option>`).join('');
            return `<tr data-idx="${idx}">
                <td><input data-f="original" value="${esc(term.original)}"></td>
                <td><input data-f="translation" value="${esc(term.translation)}"></td>
                <td><select data-f="type">${typeOpts}</select></td>
                <td><select data-f="gender">
                    <option value="" ${!term.gender ? 'selected' : ''}>${esc(t('gloss.genderNone'))}</option>
                    <option value="m" ${term.gender === 'm' ? 'selected' : ''}>${esc(t('gloss.genderM'))}</option>
                    <option value="f" ${term.gender === 'f' ? 'selected' : ''}>${esc(t('gloss.genderF'))}</option>
                    <option value="n" ${term.gender === 'n' ? 'selected' : ''}>${esc(t('gloss.genderN'))}</option>
                </select></td>
                <td><input data-f="notes" value="${esc(term.notes)}"></td>
                <td class="cnt ${cnt === 0 ? 'zero' : ''}">${cnt ?? ''}</td>
                <td class="del"><button class="danger" data-del="${idx}" title="${esc(t('gloss.delTitle'))}">✕</button></td>
            </tr>`;
        }).join('');
    }

    tbody.addEventListener('input', (e) => {
        const tr = e.target.closest('tr');
        const f = e.target.dataset.f;
        if (!tr || !f) return;
        const term = terms[+tr.dataset.idx];
        term[f] = f === 'gender' && e.target.value === '' ? null : e.target.value;
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
            toast(t('gloss.saved', { count: r.count }), 'ok');
        } catch (e) {
            toast(t('gloss.saveError', { msg: e.message }), 'error');
        }
    });

    renderRows();

    cleanup = () => {
        if (dirty && !confirm(t('gloss.leaveConfirm'))) {
            // too late to cancel hash navigation cleanly — just warn
        }
    };
}

// ============================================================
// Monitor
// ============================================================

async function renderMonitor(prefix) {
    setCrumbs(`${crumbHome()} / ${esc(prefix)} / ${esc(t('mon.heading'))}`);

    // The active model is chosen in Settings; the monitor only displays it.
    let activeProvider = 'local';
    try { activeProvider = (await api('/api/config')).activeProvider || 'local'; } catch { /* keep default */ }
    // Show the same friendly label as the settings card (provider → config group).
    const providerGroup = { local: 'logic_model', google: 'google_model', groq: 'groq_model' };
    const activeProviderLabel = t('cfg.group.' + (providerGroup[activeProvider] || 'logic_model'));

    app.innerHTML = `
        <h2>${esc(t('mon.heading'))}: ${esc(prefix)}</h2>
        <div class="toolbar">
            <label>${esc(t('mon.stageLabel'))}
                <select id="m-stage">
                    <option value="1" data-base="${esc(t('mon.stage1'))}">${esc(t('mon.stage1'))}</option>
                    <option value="2" data-base="${esc(t('mon.stage2'))}">${esc(t('mon.stage2'))}</option>
                    <option value="export" data-base="${esc(t('mon.stageExport'))}">${esc(t('mon.stageExport'))}</option>
                </select>
            </label>
            <span class="mon-model">${esc(t('mon.modelLabel'))}:
                <strong>${esc(activeProviderLabel)}</strong>
                <a href="#/settings" class="cfg-hint">(${esc(t('mon.modelInSettings'))})</a>
            </span>
            <button id="m-start" class="primary">${esc(t('mon.start'))}</button>
            <button id="m-stop" class="danger" disabled>${esc(t('mon.stop'))}</button>
            <span class="spacer"></span>
            <span id="m-status" class="badge"></span>
            <a class="btn" href="#/glossary/${encodeURIComponent(prefix)}">${esc(t('dash.glossary'))}</a>
            <a id="m-download" class="btn" href="/api/projects/${encodeURIComponent(prefix)}/output">${esc(t('dash.download'))}</a>
            <button id="m-reset" class="btn danger" title="${esc(t('mon.resetStage1Title'))}">${esc(t('mon.resetStage1'))}</button>
        </div>
        <div class="lang-row">
            <label id="m-lang-wrap" title="${esc(t('mon.langHint'))}">${esc(t('mon.targetLangLabel'))}
                <input id="m-lang" type="text" placeholder="${esc(t('mon.targetLangPlaceholder'))}" style="width:130px">
            </label>
            <label title="${esc(t('mon.langHint'))}">${esc(t('mon.suffixLabel'))}
                <input id="m-suffix" type="text" placeholder="rus" style="width:56px" maxlength="20">
            </label>
            <span class="lang-row-hint">${esc(t('mon.langHint'))}</span>
        </div>
        <div id="m-hint" class="hint" hidden></div>
        <div class="monitor-grid">
            <div>
                <div class="legend">
                    <span><span class="dot" style="background:#1e5e41"></span>${esc(t('status.success'))}</span>
                    <span><span class="dot" style="background:#6b5320"></span>${esc(t('status.best_effort'))}</span>
                    <span><span class="dot" style="background:#29456e"></span>${esc(t('status.in_progress'))}</span>
                    <span><span class="dot" style="background:#1f242e"></span>${esc(t('status.pending'))}</span>
                    <span><span class="dot ext-dot"></span>${esc(t('legend.extracted'))}</span>
                </div>
                <div id="m-grid" class="chunk-grid"><span class="loading">${esc(t('common.loading'))}</span></div>
                <details class="usage-details" open>
                    <summary>${esc(t('usage.heading'))}</summary>
                    <div id="m-usage"></div>
                </details>
            </div>
            <div>
                <div id="m-log" class="log-pane"></div>
            </div>
        </div>
    `;

    const grid = document.getElementById('m-grid');
    const usageEl = document.getElementById('m-usage');
    const logPane = document.getElementById('m-log');
    const statusEl = document.getElementById('m-status');
    const startBtn = document.getElementById('m-start');
    const stopBtn = document.getElementById('m-stop');
    const stageSel = document.getElementById('m-stage');
    const hintEl = document.getElementById('m-hint');
    const langInput = document.getElementById('m-lang');
    const suffixInput = document.getElementById('m-suffix');

    // Language is fixed when the project is created (Stage 1). For an existing
    // project show its saved values, disabled; editable only before Stage 1.
    let suffixTouched = false;
    suffixInput.addEventListener('input', () => { suffixTouched = true; });
    langInput.addEventListener('input', () => {
        if (suffixTouched) return;
        // Best-effort auto-suffix from ASCII letters of the language name.
        const ascii = langInput.value.toLowerCase().replace(/[^a-z]/g, '').slice(0, 3);
        if (ascii) suffixInput.value = ascii;
    });

    // Reflect whether the project already exists: once created, the language is
    // locked in and the inputs become read-only with the saved values.
    function syncLangControls() {
        const created = !!summary && summary.total > 0;
        langInput.disabled = created;
        suffixInput.disabled = created;
        if (created) {
            langInput.value = summary.metadata?.targetLanguage || '';
            suffixInput.value = summary.metadata?.langSuffix || '';
        }
    }

    let activeChunk = null; // 0-based index parsed from the log
    let running = false;
    let recommendApplied = false; // preselect the stage only once, then respect user choice

    // Where is the project in the pipeline? Drives the recommended next stage.
    function recommend(s) {
        if (!s || s.total === 0)
            return { stage: '1', text: t('rec.notCreated') };
        if (s.extracted < s.total)
            return { stage: '1', text: t('rec.stage1Incomplete', { done: s.extracted, total: s.total }) };
        const done = s.statuses.success + s.statuses.best_effort;
        if (done >= s.total)
            return { stage: 'export', text: t('rec.allDone') };
        if (!s.glossaryCount)
            return { stage: '2', text: t('rec.glossaryEmpty') };
        return { stage: '2', text: t('rec.canTranslate', { glossary: s.glossaryCount }) };
    }

    // Returns a warning string if the chosen stage breaks the recommended order
    // (extraction → review glossary → translation), or null if it's safe.
    function preflight(stage, s) {
        if (stage !== '2') return null;
        if (!s || s.total === 0)
            return t('pre.notCreated');
        if (s.extracted < s.total)
            return t('pre.stage1Incomplete', { done: s.extracted, total: s.total });
        if (!s.glossaryCount)
            return t('pre.glossaryEmpty');
        return null;
    }

    function applyRecommendation() {
        const rec = recommend(summary);
        // Annotate the recommended option and (once) preselect it
        for (const opt of stageSel.options) {
            const base = opt.dataset.base || opt.textContent;
            opt.textContent = opt.value === rec.stage ? t('mon.recommendedTag', { base }) : base;
        }
        if (!recommendApplied && !running) {
            stageSel.value = rec.stage;
            recommendApplied = true;
        }
        hintEl.hidden = false;
        hintEl.textContent = t('mon.recommendPrefix', { text: rec.text });
        syncLangControls();
    }

    function setRunning(v) {
        running = v;
        startBtn.disabled = v;
        stopBtn.disabled = !v;
        statusEl.textContent = v ? t('mon.running') : t('mon.stopped');
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
    function drawUsage() {
        usageEl.innerHTML = usagePanelHtml(summary?.metadata?.usage);
    }
    function updateDownload() {
        const dl = document.getElementById('m-download');
        if (!dl) return;
        // Download = assemble the book; pointless until at least one chunk is done.
        const done = summary ? summary.statuses.success + summary.statuses.best_effort : 0;
        const enabled = done > 0;
        dl.classList.toggle('disabled', !enabled);
        dl.title = enabled ? '' : t('mon.downloadDisabled');
    }
    function drawGrid() {
        drawUsage();
        updateDownload();
        if (!summary) {
            grid.innerHTML = `<span class="loading">${esc(t('mon.gridEmpty'))}</span>`;
            return;
        }
        grid.innerHTML = summary.chunks.map(c => {
            const termsValue = c.extracted
                ? (c.nTerms != null ? t('mon.chunkTermsYes', { n: c.nTerms }) : t('mon.chunkTermsYesNoCount'))
                : t('mon.chunkTermsNo');
            const title = t('mon.chunkTitle', { n: c.i + 1, status: statusLabel(c.status) })
                + '\n' + t('mon.chunkTerms', { value: termsValue })
                + (c.score != null ? t('mon.chunkScore', { score: c.score }) : '')
                + (c.attempts ? t('mon.chunkSteps', { n: c.attempts }) : '')
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
            appendLog(t('mon.processFinished', { code: j.exitCode }));
            refreshGrid();
        }
    });

    startBtn.addEventListener('click', async () => {
        const stage = stageSel.value;

        const warning = preflight(stage, summary);
        if (warning && !confirm(warning)) return;

        // Language is only sent when the project is first created (Stage 1 or a
        // direct Stage 2 run both bootstrap a fresh project).
        const body = { prefix, stage };
        if ((stage === '1' || stage === '2') && !(summary && summary.total > 0)) {
            if (langInput.value.trim()) body.lang = langInput.value.trim();
            if (suffixInput.value.trim()) body.suffix = suffixInput.value.trim();
        }

        try {
            await api('/api/run', { method: 'POST', body });
            logPane.innerHTML = '';
            toast(t('mon.stageStarted', { stage }), 'ok');
        } catch (e) {
            toast(e.message, 'error');
        }
    });

    stopBtn.addEventListener('click', async () => {
        if (!confirm(t('mon.stopConfirm'))) return;
        try { await api(`/api/projects/${encodeURIComponent(prefix)}/stop`, { method: 'POST' }); }
        catch (e) { toast(e.message, 'error'); }
    });

    document.getElementById('m-reset').addEventListener('click', async () => {
        if (running) { toast(t('mon.resetWhileRunning'), 'error'); return; }
        if (!confirm(t('mon.resetConfirm'))) return;
        try {
            const r = await api(`/api/projects/${encodeURIComponent(prefix)}/reset-stage1`, { method: 'POST' });
            toast(t('mon.resetDone', { modified: r.modified, total: r.total }), 'ok');
            refreshGrid();
        } catch (e) {
            toast(e.message, 'error');
        }
    });

    cleanup = () => es.close();
}

// ============================================================
// Chunk view
// ============================================================

async function renderChunk(prefix, i) {
    setCrumbs(`${crumbHome()} / <a href="#/monitor/${encodeURIComponent(prefix)}">${esc(prefix)}</a> / ${esc(t('chunk.crumb', { n: i + 1 }))}`);
    app.innerHTML = `<div class="loading">${esc(t('common.loading'))}</div>`;

    let data;
    try { data = await api(`/api/projects/${encodeURIComponent(prefix)}/chunks/${i}`); }
    catch (e) { app.innerHTML = `<div class="loading">${esc(t('common.error', { msg: e.message }))}</div>`; return; }

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
            <span class="score-pill">${esc(t('chunk.scorePill', { v: r.score ?? '?' }))}</span>
            <span class="score-pill">${esc(t('chunk.likePill', { v: r.like ?? '?' }))}</span>
            <span class="score-pill">${esc(t('chunk.errPill', { v: r.error ?? '?' }))}</span>` : '';
        const body = [
            r?.comment ? t('chunk.editorLabel', { comment: r.comment }) : '',
            h.translator_comment ? t('chunk.translatorLabel', { comment: h.translator_comment }) : ''
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
            <a class="btn" href="${i <= 0 ? `#/monitor/${encodeURIComponent(prefix)}` : `#/chunk/${encodeURIComponent(prefix)}/${i - 1}`}">${i <= 0 ? `← ${esc(t('mon.heading'))}` : `← ${i}`}</a>
            <h2 style="margin:0">${esc(t('chunk.heading', { i: i + 1, total }))}</h2>
            ${i >= total - 1 ? '' : `<a class="btn" href="#/chunk/${encodeURIComponent(prefix)}/${i + 1}">${i + 2} →</a>`}
            <span class="badge b-${status}">${esc(statusLabel(status))}</span>
            <span class="badge">${esc(t('chunk.tokens', { n: chunk.tokens ?? '?' }))}</span>
            <span class="badge" title="${esc(t('chunk.termsTitle'))}">${extracted ? esc(t('chunk.termsExtracted', { n: nTerms ?? '✓' })) : esc(t('chunk.termsNot'))}</span>
            <button id="c-toggle-orig" title="${esc(t('chunk.toggleTitle'))}"></button>
            <span class="font-ctl">
                <button id="c-font-dec" title="${esc(t('chunk.fontSmaller'))}">A−</button>
                <button id="c-font-size" class="font-size-label"></button>
                <button id="c-font-inc" title="${esc(t('chunk.fontLarger'))}">A+</button>
            </span>
            <span class="spacer"></span>
            <button id="c-save">${esc(t('common.save'))}</button>
            <button id="c-approve" class="primary">${esc(t('chunk.approve'))}</button>
            <button id="c-reset" class="danger">${esc(t('chunk.reset'))}</button>
        </div>
        <div class="panes" id="c-panes">
            <div class="pane" id="c-pane-orig">
                <h4>${esc(t('chunk.original'))}</h4>
                <div class="original-text">${esc(chunk.original)}</div>
            </div>
            <div class="pane">
                <h4>${esc(t('chunk.translationEditable'))}</h4>
                <textarea id="c-translation">${esc(chunk.translation || '')}</textarea>
            </div>
        </div>
        <h3>${esc(t('chunk.history', { n: history.length }))}</h3>
        ${historyHtml || `<p class="loading">${esc(t('chunk.historyEmpty'))}</p>`}
    `;

    const ta = document.getElementById('c-translation');

    // Toggle original pane — persisted so it stays hidden while navigating chunks
    const panes = document.getElementById('c-panes');
    const toggleBtn = document.getElementById('c-toggle-orig');
    function applyOrigHidden(hidden) {
        panes.classList.toggle('hide-original', hidden);
        toggleBtn.textContent = hidden ? t('chunk.showOriginal') : t('chunk.hideOriginal');
    }
    applyOrigHidden(localStorage.getItem('prozetta.hideOriginal') === '1');
    toggleBtn.addEventListener('click', () => {
        const hidden = !panes.classList.contains('hide-original');
        localStorage.setItem('prozetta.hideOriginal', hidden ? '1' : '0');
        applyOrigHidden(hidden);
    });

    // Reader font size — applied to both panes via a CSS variable, persisted.
    const FONT_DEFAULT = 15, FONT_MIN = 11, FONT_MAX = 32;
    const sizeLabel = document.getElementById('c-font-size');
    function readFontSize() {
        const v = parseInt(localStorage.getItem('prozetta.fontSize'), 10);
        return Number.isFinite(v) ? Math.min(FONT_MAX, Math.max(FONT_MIN, v)) : FONT_DEFAULT;
    }
    function applyFontSize(px) {
        const size = Math.min(FONT_MAX, Math.max(FONT_MIN, px));
        localStorage.setItem('prozetta.fontSize', String(size));
        panes.style.setProperty('--reader-font', size + 'px');
        sizeLabel.textContent = size;
        sizeLabel.title = t('chunk.fontResetTitle', { size });
    }
    applyFontSize(readFontSize());
    document.getElementById('c-font-dec').addEventListener('click', () => applyFontSize(readFontSize() - 1));
    document.getElementById('c-font-inc').addEventListener('click', () => applyFontSize(readFontSize() + 1));
    sizeLabel.addEventListener('click', () => applyFontSize(FONT_DEFAULT));

    async function saveChunk(approve) {
        const body = { translation: ta.value };
        if (approve) body.translation_status = 'success';
        try {
            await api(`/api/projects/${encodeURIComponent(prefix)}/chunks/${i}`, { method: 'PUT', body });
            toast(approve ? t('chunk.savedApproved') : t('chunk.saved'), 'ok');
            if (approve) renderChunk(prefix, i);
        } catch (e) {
            toast(e.message, 'error');
        }
    }

    document.getElementById('c-save').addEventListener('click', () => saveChunk(false));
    document.getElementById('c-approve').addEventListener('click', () => saveChunk(true));
    document.getElementById('c-reset').addEventListener('click', async () => {
        if (!confirm(t('chunk.resetConfirm'))) return;
        try {
            await api(`/api/projects/${encodeURIComponent(prefix)}/chunks/${i}`, { method: 'PUT', body: { reset: true } });
            toast(t('chunk.resetDone'), 'ok');
            renderChunk(prefix, i);
        } catch (e) {
            toast(e.message, 'error');
        }
    });
}

// ============================================================
// Settings (config.js via config.overrides.json)
// ============================================================

async function renderSettings() {
    setCrumbs(`${crumbHome()} / ${esc(t('settings.title'))}`);
    app.innerHTML = `<div class="loading">${esc(t('common.loading'))}</div>`;

    let data;
    try { data = await api('/api/config'); }
    catch (e) { app.innerHTML = `<div class="loading">${esc(t('common.error', { msg: e.message }))}</div>`; return; }

    const groups = data.groups;
    const fieldId = (g, k) => `cfg__${g}__${k}`;

    function fieldHtml(groupId, f) {
        const id = fieldId(groupId, f.key);
        const hintKey = 'cfg.hint.' + f.key;
        const hintRaw = t(hintKey);
        const hint = hintRaw !== hintKey ? `<span class="cfg-hint">${esc(hintRaw)}</span>` : '';
        const ovr = f.overridden ? `<span class="badge cfg-ovr">${esc(t('settings.overridden'))}</span>` : '';

        let input;
        if (f.type === 'secret') {
            const status = f.set ? t('settings.apiKeySet') : t('settings.apiKeyUnset');
            input = `<input type="password" id="${id}" data-type="secret" autocomplete="off"
                        placeholder="${esc(t('settings.apiKeyPlaceholder'))}">
                     <span class="cfg-hint">${esc(status)}</span>`;
        } else if (f.type === 'bool') {
            input = `<input type="checkbox" id="${id}" data-type="bool" data-orig="${f.value ? '1' : ''}" ${f.value ? 'checked' : ''}>`;
        } else if (f.key === 'promptLang') {
            const opts = ['ru', 'en'].map(v =>
                `<option value="${v}" ${f.value === v ? 'selected' : ''}>${esc(t('cfg.promptLang.' + v))}</option>`).join('');
            input = `<select id="${id}" data-type="string" data-orig="${esc(f.value)}">${opts}</select>${hint}`;
        } else if (f.type === 'int' || f.type === 'float') {
            const step = f.type === 'int' ? '1' : 'any';
            input = `<input type="number" step="${step}" id="${id}" data-type="${f.type}" data-orig="${esc(f.value)}" value="${esc(f.value)}">${hint}`;
        } else {
            input = `<input type="text" id="${id}" data-type="string" data-orig="${esc(f.value)}" value="${esc(f.value)}">${hint}`;
        }
        return `<div class="cfg-field">
            <label for="${id}">${esc(f.key)}${ovr}</label>
            <div class="cfg-input">${input}</div>
        </div>`;
    }

    const groupProvider = { logic_model: 'local', google_model: 'google', groq_model: 'groq' };

    function groupHtml(g) {
        const provider = groupProvider[g.id];
        const testArea = provider ? `
            <span class="cfg-test-area">
                <button class="btn cfg-test" data-group="${esc(g.id)}" data-provider="${esc(provider)}">${esc(t('settings.test'))}</button>
                <span class="cfg-test-result" data-for="${esc(g.id)}"></span>
            </span>` : '';
        return `<div class="card cfg-group">
            <div class="title">${esc(t('cfg.group.' + g.id))} <span class="cfg-gid">${esc(g.id)}</span>${testArea}</div>
            ${g.fields.map(f => fieldHtml(g.id, f)).join('')}
        </div>`;
    }

    const modelGroups = groups.filter(g => g.kind === 'model');
    const pipeGroups = groups.filter(g => g.kind === 'pipeline');
    const transGroups = groups.filter(g => g.kind === 'translation');
    const providers = ['local', 'google', 'groq'];
    const activeProvider = data.activeProvider || 'local';
    // Show the same friendly label as each provider's card (e.g. "Custom (OpenAI-compatible)").
    const providerLabel = (p) => {
        const gid = Object.keys(groupProvider).find(k => groupProvider[k] === p);
        return gid ? t('cfg.group.' + gid) : p;
    };

    app.innerHTML = `
        <h2>${esc(t('settings.title'))}</h2>
        <div class="toolbar">
            <button id="cfg-save" class="primary">${esc(t('common.save'))}</button>
            <button id="cfg-reset" class="danger">${esc(t('settings.reset'))}</button>
        </div>
        <div class="hint">${esc(t('settings.note'))}</div>
        <h3>${esc(t('settings.sectionModels'))}</h3>
        <div class="card cfg-group cfg-provider">
            <div class="cfg-field">
                <label for="cfg-active-provider">${esc(t('settings.activeProvider'))}</label>
                <div class="cfg-input">
                    <select id="cfg-active-provider">
                        ${providers.map(p => `<option value="${esc(p)}" ${p === activeProvider ? 'selected' : ''}>${esc(providerLabel(p))}</option>`).join('')}
                    </select>
                    <span class="cfg-hint">${esc(t('settings.activeProviderHint'))}</span>
                </div>
            </div>
        </div>
        <div class="cards cards-col">${modelGroups.map(groupHtml).join('')}</div>
        <h3>${esc(t('settings.sectionPipeline'))}</h3>
        <div class="cards cards-col">${pipeGroups.map(groupHtml).join('')}</div>
        <h3>${esc(t('settings.sectionTranslation'))}</h3>
        <div class="cards cards-col">${transGroups.map(groupHtml).join('')}</div>
    `;

    // Collect only changed fields, so config.overrides.json stays minimal.
    function collectChanges() {
        const payload = {};
        for (const g of groups) {
            for (const f of g.fields) {
                const el = document.getElementById(fieldId(g.id, f.key));
                if (!el) continue;
                const type = el.dataset.type;
                if (type === 'secret') {
                    if (el.value.trim() !== '') (payload[g.id] ||= {})[f.key] = el.value;
                    continue;
                }
                if (type === 'bool') {
                    if ((el.checked ? '1' : '') !== el.dataset.orig) (payload[g.id] ||= {})[f.key] = el.checked;
                    continue;
                }
                if (el.value !== el.dataset.orig) (payload[g.id] ||= {})[f.key] = el.value;
            }
        }
        const provEl = document.getElementById('cfg-active-provider');
        if (provEl && provEl.value !== activeProvider) payload.activeProvider = provEl.value;
        return payload;
    }

    document.getElementById('cfg-save').addEventListener('click', async () => {
        try {
            await api('/api/config', { method: 'PUT', body: collectChanges() });
            toast(t('settings.saved'), 'ok');
            renderSettings();
        } catch (e) { toast(e.message, 'error'); }
    });

    document.getElementById('cfg-reset').addEventListener('click', async () => {
        if (!confirm(t('settings.resetConfirm'))) return;
        try {
            await api('/api/config/reset', { method: 'POST' });
            toast(t('settings.resetDone'), 'ok');
            renderSettings();
        } catch (e) { toast(e.message, 'error'); }
    });

    // Read all current (unsaved) form values for one provider group.
    function collectGroupValues(groupId) {
        const g = groups.find(x => x.id === groupId);
        const out = {};
        if (!g) return out;
        for (const f of g.fields) {
            const el = document.getElementById(fieldId(groupId, f.key));
            if (!el) continue;
            out[f.key] = el.dataset.type === 'bool' ? el.checked : el.value;
        }
        return out;
    }

    app.querySelectorAll('.cfg-test').forEach(btn => {
        btn.addEventListener('click', async () => {
            const groupId = btn.dataset.group;
            const resultEl = app.querySelector(`.cfg-test-result[data-for="${groupId}"]`);
            btn.disabled = true;
            resultEl.className = 'cfg-test-result';
            resultEl.textContent = t('settings.testing');
            resultEl.removeAttribute('title');
            try {
                const r = await api('/api/config/test', {
                    method: 'POST',
                    body: { provider: btn.dataset.provider, values: collectGroupValues(groupId) },
                });
                if (r.ok) {
                    resultEl.classList.add('ok');
                    resultEl.textContent = t('settings.testOk', { ms: r.latencyMs });
                    resultEl.title = r.reply || '';
                } else {
                    resultEl.classList.add('err');
                    resultEl.textContent = t('settings.testFail');
                    resultEl.title = r.error || '';
                }
            } catch (e) {
                resultEl.classList.add('err');
                resultEl.textContent = t('settings.testFail');
                resultEl.title = e.message;
            } finally {
                btn.disabled = false;
            }
        });
    });
}

// ============================================================
// Language switcher
// ============================================================

function initLangSwitcher() {
    const settingsLink = document.getElementById('settings-link');
    if (settingsLink) settingsLink.title = t('nav.settings');

    const sel = document.getElementById('lang-select');
    if (!sel) return;
    sel.title = t('header.lang');
    sel.innerHTML = Object.entries(i18n.langs)
        .map(([code, meta]) => `<option value="${esc(code)}">${esc(meta.name)}</option>`).join('');
    sel.value = i18n.getLang();
    sel.addEventListener('change', () => {
        i18n.setLang(sel.value);
        sel.title = t('header.lang');
        if (settingsLink) settingsLink.title = t('nav.settings');
        route(); // re-render current view in the new language
    });
}

// --- Go ---
initLangSwitcher();
route();
