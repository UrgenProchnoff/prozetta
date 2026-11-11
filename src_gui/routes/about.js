/** The program itself: the running version, newer builds, the changelog and the help pages. */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { ROOT, UPDATE_CACHE_PATH, app } from '../app.js';
import { loadEffectiveConfig } from '../helpers.js';

/**
 * What version is running, resolved once at startup.
 *
 * The commit is the part that actually identifies a build: the package version
 * moves rarely, while the thing a person is looking at moves every day. Read
 * through git rather than from a baked file so it cannot drift from reality —
 * and it degrades to the package version alone when there is no checkout, which
 * is how an install from an archive looks.
 *
 * `dirty` matters more than it looks: most of the time this runs from a working
 * tree with edits in it, and a bare commit hash would then name a build that
 * does not exist anywhere.
 */
const VERSION = (() => {
    let version = '0.0.0';
    let repository = null;
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
        version = pkg.version || version;
        repository = String(pkg.repository?.url || pkg.repository || '').replace(/\.git$/, '') || null;
    } catch { /* keep the placeholder */ }

    const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    try {
        return {
            version,
            repository,
            commit: git('rev-parse', '--short', 'HEAD'),
            commitDate: git('log', '-1', '--format=%cI'),
            branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
            dirty: git('status', '--porcelain', '--untracked-files=no').length > 0,
        };
    } catch {
        // No checkout — which is most installations, since a release is a ZIP
        // and a ZIP has no .git. The archive carries its own answer instead: see
        // build-info.json and the export-subst line in .gitattributes.
        return { version, repository, branch: null, dirty: false, ...archiveBuild() };
    }
})();

/** The commit an archive was made from, or nulls in a checkout. */
function archiveBuild() {
    const empty = { commit: null, commitDate: null };
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'build-info.json'), 'utf-8'));
        // Untouched placeholders mean this is a checkout after all, and git has
        // already had its say.
        if (String(raw.commit || '').startsWith('$Format')) return empty;
        return { commit: String(raw.commit).slice(0, 40) || null, commitDate: raw.commitDate || null };
    } catch { return empty; }
}

app.get('/api/version', (req, res) => {
    res.json({ ...VERSION, changelog: fs.existsSync(path.join(ROOT, 'CHANGELOG.md')) });
});

// --- Is there a newer build than this one ---
//
// A release is a ZIP, and a ZIP cannot learn that it has been superseded: its
// owner keeps running August's build into September because nothing ever tells
// them otherwise. So the program asks GitHub for the date at the top of the
// repository and compares it with its own build date — which it already knows
// in both kinds of install, from git in a checkout and from build-info.json in
// an archive.
//
// One anonymous GET, once a day, to the repository the program came from.
// Nothing is downloaded, nothing is sent, and when the answer is "you are
// current" — or when there is no network at all — the interface says nothing.
const UPDATE_TTL_MS = 24 * 60 * 60 * 1000;
// A failed attempt is remembered too, for an hour rather than a day. Without
// it an offline machine — or one that has run into GitHub's hourly limit for
// anonymous requests — would try again on every page opened, which is both
// impolite and pointless.
const UPDATE_RETRY_MS = 60 * 60 * 1000;
const UPDATE_TIMEOUT_MS = 5000;

/**
 * The answer from last time, if it is still fresh enough to reuse: the tip, or
 * `{failed:true}` for an attempt that got nowhere, or null when it is time to
 * ask again.
 */
function readUpdateCache() {
    try {
        const raw = JSON.parse(fs.readFileSync(UPDATE_CACHE_PATH, 'utf-8'));
        const age = Date.now() - (raw.checkedAt || 0);
        if (raw.failed) return age > UPDATE_RETRY_MS ? null : { failed: true };
        return age > UPDATE_TTL_MS ? null : raw;
    } catch { return null; }
}

function writeUpdateCache(data) {
    // A cache that cannot be written costs one extra request tomorrow, which is
    // not worth failing a page over.
    try { fs.writeFileSync(UPDATE_CACHE_PATH, JSON.stringify({ ...data, checkedAt: Date.now() }, null, 2)); }
    catch { /* ignore */ }
}

/**
 * The top of the repository's default branch, or null if GitHub could not be
 * reached or answered with something unexpected. A failure here is not an
 * error to report: nobody asked for this check, so nobody should be told it
 * failed.
 */
async function fetchRepoTip(repository) {
    const m = /github\.com\/([^/]+)\/([^/.]+)/.exec(repository || '');
    if (!m) return null;
    try {
        const r = await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}/commits/HEAD`, {
            // GitHub refuses requests without a user agent, and the accept
            // header pins the response shape to the documented one.
            headers: { accept: 'application/vnd.github+json', 'user-agent': 'prozetta' },
            signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS),
        });
        if (!r.ok) return null;
        const j = await r.json();
        const sha = String(j?.sha || '');
        const date = j?.commit?.committer?.date || j?.commit?.author?.date || null;
        if (!/^[0-9a-f]{7,40}$/.test(sha) || !date || !Number.isFinite(Date.parse(date))) return null;
        return { commit: sha.slice(0, 7), commitDate: date };
    } catch { return null; }
}

app.get('/api/update', async (req, res) => {
    const silent = { available: false };

    // Someone editing the program is not someone who needs telling that the
    // program has moved on: a dirty tree or a branch of one's own is work in
    // progress, and the mark would be noise on every page of it.
    if (VERSION.dirty || (VERSION.branch && VERSION.branch !== 'main')) return res.json(silent);
    // Nothing to compare against: a folder copied from somewhere, with neither
    // git beside it nor a build stamp inside it.
    if (!VERSION.commitDate || !VERSION.repository) return res.json(silent);

    try {
        const cfg = await loadEffectiveConfig();
        if (cfg.app?.checkUpdates === false) return res.json(silent);
    } catch { /* an unreadable config is not a reason to skip the check */ }

    let tip = readUpdateCache();
    if (tip?.failed) return res.json(silent);
    if (!tip) {
        tip = await fetchRepoTip(VERSION.repository);
        writeUpdateCache(tip || { failed: true });
        if (!tip) return res.json(silent);
    }

    // Same commit is the common answer; a date at or before ours covers the
    // rest, including a local commit that has not been pushed yet.
    if (tip.commit === VERSION.commit) return res.json(silent);
    if (Date.parse(tip.commitDate) <= Date.parse(VERSION.commitDate)) return res.json(silent);

    res.json({
        available: true,
        commit: tip.commit,
        commitDate: tip.commitDate,
        mineDate: VERSION.commitDate,
        // What changed between the two, in the words of the commits themselves.
        // Both ends are named by commit rather than by branch: the base is a
        // commit the repository has (this is only reached from a clean checkout
        // of main or from an archive of one), and the tip is the one just
        // looked up, so the link keeps meaning what it meant when it was made.
        whatsNew: `${VERSION.repository}/compare/${VERSION.commit}...${tip.commit}`,
    });
});

// A commit fingerprint, written either as `abc1234` at the head of an entry or
// as (abc1234, def5678) inside one. Both forms are recognised so the file can be
// reorganised without the links going quiet.
const COMMIT_REF_RE = /`([0-9a-f]{7,40})`|\(([0-9a-f]{7,40}(?:,\s*[0-9a-f]{7,40})*)\)/g;

/**
 * Look up every commit the changelog refers to, in one pass over the log rather
 * than one call per hash: the file names forty of them, and forty git processes
 * to render a page is forty too many.
 */
function describeCommits(text) {
    const wanted = new Set();
    for (const m of text.matchAll(COMMIT_REF_RE)) {
        for (const h of (m[1] || m[2] || '').split(/,\s*/)) if (h) wanted.add(h);
    }
    if (!wanted.size) return {};
    const found = {};
    try {
        const log = execFileSync('git', ['log', '--format=%h%x00%s%x00%cI', '--max-count=2000'],
            { cwd: ROOT, encoding: 'utf-8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
        for (const line of log.split('\n')) {
            const [hash, subject, date] = line.split('\0');
            if (hash && wanted.has(hash)) found[hash] = { subject, date };
        }
    } catch {
        // No checkout, so nothing was checked — which is not the same as having
        // checked and found nothing. A hash git denies is worth marking dead: it
        // is a typo or a rebase. A hash nobody could ask about is just a hash,
        // and the reader still wants the link. Null says which of the two this
        // is; the page decides what to do about it.
        return null;
    }
    return found;
}

// The changelog as written, for the interface to render. Read per request so an
// edit shows up without restarting the server.
//
// Translations follow the convention the README already uses: CHANGELOG.md is
// English, CHANGELOG.<lang>.md is everything else. A language with no file of
// its own falls back to English and says so, rather than showing nothing.
app.get('/api/changelog', (req, res) => {
    // The value decides a filename, so it is matched rather than interpolated.
    const lang = /^[a-z]{2}$/.test(String(req.query.lang || '')) ? String(req.query.lang) : 'en';
    const translated = path.join(ROOT, `CHANGELOG.${lang}.md`);
    const english = path.join(ROOT, 'CHANGELOG.md');

    const file = lang !== 'en' && fs.existsSync(translated) ? translated : english;
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'No CHANGELOG.md' });
    try {
        const text = fs.readFileSync(file, 'utf-8');
        res.json({
            text,
            lang: file === english ? 'en' : lang,
            requested: lang,
            repository: VERSION.repository,
            // Subject and date for every commit the file names, so an entry can
            // show what it points at and a hash that no longer resolves — a
            // typo, or a rebase — is visibly dead rather than a link to nothing.
            commits: describeCommits(text),
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * A help article, in the reader's language when there is one.
 *
 * Prose lives in docs/ and not in the dictionary. Interface strings are labels a
 * checker can hold to account for existing in both languages; an article is
 * paragraphs, and putting it in i18n.js would make every edit to a sentence an
 * edit to the file every button reads.
 *
 * Falls back to English the way the changelog does — an article that is not
 * translated yet is better read in the wrong language than not read.
 */
// The screens, in the order somebody meets them. The list is here and not read
// off the directory because the order is editorial: alphabetical, "book" would
// come before "monitor" and a reader would meet the last screen first.
// The walkthrough first, then an article per screen in the order the screens come
// up. The guide is not about a screen, which is why it used to be linked only
// from the README on GitHub — findable by someone who had not installed the
// program yet, and by nobody who had.
const HELP_TOPICS = ['guide', 'projects', 'monitor', 'glossary', 'passport', 'chunk', 'history', 'book', 'settings'];

/** The article's own first heading, so a title is never written down twice. */
function helpTitle(file) {
    try {
        const head = fs.readFileSync(file, 'utf-8').slice(0, 400);
        const m = head.match(/^#\s+(.+)$/m);
        return m ? m[1].trim() : null;
    } catch { return null; }
}

app.get('/api/help', (req, res) => {
    // Both values pick a filename, so both are matched rather than interpolated.
    const topic = /^[a-z]{2,20}$/.test(String(req.query.topic || '')) ? String(req.query.topic) : '';
    const lang = /^[a-z]{2}$/.test(String(req.query.lang || '')) ? String(req.query.lang) : 'en';

    // No topic: what there is to read.
    if (!topic) {
        const topics = HELP_TOPICS.map(name => {
            const wanted = path.join(ROOT, 'docs', `${name.toUpperCase()}.${lang}.md`);
            const english = path.join(ROOT, 'docs', `${name.toUpperCase()}.en.md`);
            const file = fs.existsSync(wanted) ? wanted : english;
            if (!fs.existsSync(file)) return null;
            return { topic: name, title: helpTitle(file), translated: file === wanted };
        }).filter(Boolean);
        return res.json({ topics });
    }

    const name = topic.toUpperCase();
    const wanted = path.join(ROOT, 'docs', `${name}.${lang}.md`);
    const english = path.join(ROOT, 'docs', `${name}.en.md`);
    const file = fs.existsSync(wanted) ? wanted : english;
    if (!fs.existsSync(file)) return res.status(404).json({ error: `No help article for "${topic}".` });

    try {
        res.json({
            text: fs.readFileSync(file, 'utf-8'), lang: file === wanted ? lang : 'en', requested: lang,
            // Where a link to a file outside the help should point: the articles
            // are written for the repository, and README is not served from here.
            repository: VERSION.repository,
            // Where this article sits in the reading order, so a page can offer
            // the next one without the front end keeping its own copy of the list.
            topics: HELP_TOPICS.filter(n => fs.existsSync(path.join(ROOT, 'docs', `${n.toUpperCase()}.en.md`)))
                .map(n => ({
                    topic: n,
                    title: helpTitle(path.join(ROOT, 'docs',
                        fs.existsSync(path.join(ROOT, 'docs', `${n.toUpperCase()}.${lang}.md`))
                            ? `${n.toUpperCase()}.${lang}.md` : `${n.toUpperCase()}.en.md`)),
                })),
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
