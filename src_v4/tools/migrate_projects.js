/**
 * Move project files out of the working directory into `projects/<book>/`.
 *
 * Projects used to be a scatter of prefixed files in the root — state, glossary,
 * passport, review, log, cover, and whatever backups had accumulated beside
 * them. This puts each book's files in a folder of its own and drops the prefix
 * from their names, since the folder now carries it.
 *
 * Shows what it would do and changes nothing unless asked. The files hold hours
 * of model work, so the default is to look.
 *
 * Usage:
 *   node src_v4/tools/migrate_projects.js            # show the plan
 *   node src_v4/tools/migrate_projects.js --apply    # carry it out
 */

import fs from 'fs';
import path from 'path';
import { projectPaths, ensureProjectDir } from '../core/paths.js';

const ROOT = process.cwd();

// Old name (after the prefix) → new name inside the project folder. Backups and
// anything else that shares the prefix are handled separately, since their names
// are open-ended.
const RENAMES = [
    ['_project_state.json', 'state.json'],
    ['_glossary.json', 'glossary.json'],
    ['_passport.json', 'passport.json'],
    ['_glossary_review.json', 'glossary_review.json'],
    ['_run.log', 'run.log'],
    ['_cover.jpg', 'cover.jpg'],
    ['_cover.png', 'cover.png'],
];

function plan() {
    const files = fs.readdirSync(ROOT, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name);
    const prefixes = files
        .filter(f => f.endsWith('_project_state.json'))
        .map(f => f.slice(0, -'_project_state.json'.length))
        // Backups of a deleted project ("..._project_state.json.deleted.bak")
        // do not end with the suffix, so they never get this far.
        .filter(Boolean);

    // Longest first: one prefix can be a prefix of another, and a file must be
    // claimed by the most specific project that could own it.
    prefixes.sort((a, b) => b.length - a.length);

    const claimed = new Set();
    const moves = [];
    for (const prefix of prefixes) {
        const dest = projectPaths(ROOT, prefix);
        for (const [suffix, target] of RENAMES) {
            const from = prefix + suffix;
            if (!files.includes(from) || claimed.has(from)) continue;
            claimed.add(from);
            moves.push({ prefix, from, to: path.join(dest.dir, target) });
        }
        // Everything else carrying this prefix: .bak, .old, timestamped copies,
        // the pre-reset snapshot. Kept under their own names, minus the prefix,
        // because guessing at their meaning would be worse than preserving it.
        for (const f of files) {
            if (claimed.has(f) || !f.startsWith(prefix + '_')) continue;
            if (!/\.(bak|old)$/.test(f)) continue;
            claimed.add(f);
            moves.push({ prefix, from: f, to: path.join(dest.dir, f.slice(prefix.length + 1)) });
        }
    }
    return { prefixes, moves };
}

function main() {
    const apply = process.argv.includes('--apply');
    const { prefixes, moves } = plan();

    if (!prefixes.length) {
        console.log('[Migrate] No project files in the working directory — nothing to move.');
        return;
    }

    let bytes = 0;
    const byPrefix = new Map();
    for (const m of moves) {
        if (!byPrefix.has(m.prefix)) byPrefix.set(m.prefix, []);
        byPrefix.get(m.prefix).push(m);
        try { bytes += fs.statSync(path.join(ROOT, m.from)).size; } catch { /* counted as zero */ }
    }

    console.log(`\n[Migrate] ${prefixes.length} project(s), ${moves.length} file(s), ${(bytes / 1048576).toFixed(1)} MB\n`);
    for (const [prefix, list] of byPrefix) {
        console.log(`  projects/${prefix}/`);
        for (const m of list) console.log(`      ${path.basename(m.to).padEnd(24)} ← ${m.from}`);
    }

    // A destination that already holds a file is not overwritten: a half-run
    // migration followed by a full one must not eat the newer copy.
    const conflicts = moves.filter(m => fs.existsSync(m.to));
    if (conflicts.length) {
        console.error(`\n[Migrate] ${conflicts.length} destination(s) already exist and would be overwritten:`);
        for (const m of conflicts) console.error(`      ${m.to}`);
        console.error('[Migrate] Nothing moved. Remove or rename them and run again.\n');
        process.exitCode = 1;
        return;
    }

    if (!apply) {
        console.log('\n[Migrate] Nothing moved. Run with --apply to carry this out.\n');
        return;
    }

    let moved = 0;
    for (const m of moves) {
        ensureProjectDir(ROOT, m.prefix);
        try {
            fs.renameSync(path.join(ROOT, m.from), m.to);
            moved++;
        } catch (e) {
            console.error(`[Migrate] Could not move ${m.from}: ${e.message}`);
            process.exitCode = 1;
        }
    }
    console.log(`\n[Migrate] Moved ${moved} of ${moves.length} file(s) into projects/.\n`);
}

main();
