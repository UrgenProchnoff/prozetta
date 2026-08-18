/**
 * Does the changelog account for the work?
 *
 * The file drifted twice before this existed: once a change went unrecorded, and
 * once an entry stayed after the thing it described had been replaced. Both were
 * invisible because nothing connected an entry to a commit. Now every entry
 * names one, which makes the question mechanical — and a mechanical question
 * should be asked by a program rather than remembered by a person.
 *
 * Reports, and exits non-zero on anything wrong:
 *   - commits with no entry (the change nobody wrote down);
 *   - entries naming a commit that does not exist (a typo, or a rebase);
 *   - entries out of order (the file claims to follow the order of the work);
 *   - a commit described in one language but not the other.
 *
 * Usage:
 *   node src_v4/tools/changelog_check.js            # against origin/main
 *   node src_v4/tools/changelog_check.js --since=main
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILES = { en: 'CHANGELOG.md', ru: 'CHANGELOG.ru.md' };

// Both the head-of-entry form and the inline one, so the file can be
// reorganised without this losing sight of it.
const REF_RE = /`([0-9a-f]{7,40})`|\(([0-9a-f]{7,40}(?:,\s*[0-9a-f]{7,40})*)\)/g;

// stderr is discarded: the only calls that fail here are the deliberate
// existence probes, and git's "fatal: Not a valid object name" printed beside
// this tool's own report would read as a crash rather than as the answer.
function git(...args) {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** Fingerprints named in a file, in the order they appear. */
function refsInOrder(text) {
    const out = [];
    for (const m of text.matchAll(REF_RE)) {
        for (const h of (m[1] || m[2] || '').split(/,\s*/)) if (h) out.push(h);
    }
    return out;
}

function main() {
    const sinceArg = process.argv.find(a => a.startsWith('--since='));
    const since = sinceArg ? sinceArg.split('=')[1] : 'origin/main';

    let range;
    try {
        git('rev-parse', '--verify', since);
        range = `${since}..HEAD`;
    } catch {
        console.error(`[Changelog] No such ref: ${since} — checking the whole history instead.`);
        range = 'HEAD';
    }

    const commits = git('log', '--format=%h', '--reverse', range).split('\n').filter(Boolean);
    const position = new Map(commits.map((h, i) => [h, i]));
    if (!commits.length) {
        console.log('[Changelog] No commits in range — nothing to check.');
        return;
    }

    let problems = 0;
    const seen = {};

    for (const [lang, file] of Object.entries(FILES)) {
        const full = path.join(ROOT, file);
        if (!fs.existsSync(full)) {
            console.error(`[Changelog] Missing: ${file}`);
            problems++;
            continue;
        }
        const refs = refsInOrder(fs.readFileSync(full, 'utf-8'));
        seen[lang] = new Set(refs);

        const unknown = refs.filter(h => !position.has(h));
        // A hash outside the range is not necessarily wrong — an older release
        // section names older commits — so only complain when git cannot resolve
        // it at all.
        const dead = unknown.filter(h => {
            try { git('cat-file', '-e', `${h}^{commit}`); return false; } catch { return true; }
        });
        for (const h of dead) {
            console.error(`[Changelog] ${file}: no such commit: ${h}`);
            problems++;
        }

        // Order, checked only over the commits in range: those are the ones the
        // file claims to list in the order the work happened.
        const inRange = refs.filter(h => position.has(h));
        for (let i = 1; i < inRange.length; i++) {
            if (position.get(inRange[i]) < position.get(inRange[i - 1])) {
                console.error(`[Changelog] ${file}: out of order — ${inRange[i]} comes before ${inRange[i - 1]} in git`);
                problems++;
            }
        }
    }

    // A commit cannot carry its own fingerprint — writing the line changes the
    // hash the line names. So a change is recorded by the commit that follows
    // it, and the commit doing the recording touches nothing but these files.
    // Such a commit is the record rather than a change to the product, and
    // requiring it to record itself would be a loop with no exit.
    const isBookkeeping = (h) => {
        const touched = git('show', '--name-only', '--format=', h).split('\n').filter(Boolean);
        return touched.length > 0 && touched.every(f => Object.values(FILES).includes(f));
    };

    for (const h of commits) {
        const missing = Object.keys(FILES).filter(lang => !seen[lang]?.has(h));
        if (!missing.length) continue;
        if (isBookkeeping(h)) continue;
        const subject = git('log', '-1', '--format=%s', h);
        if (h === commits[commits.length - 1]) {
            console.log(`[Changelog] the newest commit has no line yet — write it in the next one: ${h}  ${subject}`);
            continue;
        }
        console.error(`[Changelog] not recorded in ${missing.join(', ')}: ${h}  ${subject}`);
        problems++;
    }

    if (problems) {
        console.error(`\n[Changelog] ${problems} problem(s). Every commit needs a line, and every line a commit.`);
        process.exitCode = 1;
    } else {
        console.log(`[Changelog] ${commits.length} commit(s) in ${range}: all recorded, in order, in both languages.`);
    }
}

main();
