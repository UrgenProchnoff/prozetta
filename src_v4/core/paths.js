/**
 * Where a project's files live.
 *
 * One folder per book under `projects/`, holding everything the pipeline
 * produces about it. The prefix names the folder rather than every file inside
 * it, so a book called "Ryuker_The_hacker_and_the_antst" stops appearing in
 * thirty-five filenames.
 *
 * This module exists because the answer used to be given in two places — the
 * state manager and the GUI server — and they drifted. Deleting a project meant
 * listing its files by hand, and that list was twice found incomplete: once
 * missing the passport, once the glossary review. A directory cannot be
 * forgotten the way an entry in a list can.
 *
 * The source text and the finished translation are deliberately not here. They
 * live in `txt/`, where a person puts books in and takes translations out;
 * `projects/` is for what only the machine reads.
 */

import fs from 'fs';
import path from 'path';

export const PROJECTS_DIR = 'projects';

/** The folder holding everything about one book. */
export function projectDir(workDir, prefix) {
    return path.join(workDir, PROJECTS_DIR, prefix);
}

/**
 * Every path the pipeline writes for a project.
 *
 * @returns {{dir: string, state: string, glossary: string, passport: string,
 *            review: string, translationReview: string, log: string,
 *            cover: (ext: string) => string}}
 */
export function projectPaths(workDir, prefix) {
    const dir = projectDir(workDir, prefix);
    return {
        dir,
        state: path.join(dir, 'state.json'),
        glossary: path.join(dir, 'glossary.json'),
        passport: path.join(dir, 'passport.json'),
        review: path.join(dir, 'glossary_review.json'),
        translationReview: path.join(dir, 'translation_review.json'),
        log: path.join(dir, 'run.log'),
        cover: (ext) => path.join(dir, `cover.${ext}`),
    };
}

/** Create the folder if it is not there yet. Safe to call repeatedly. */
export function ensureProjectDir(workDir, prefix) {
    const dir = projectDir(workDir, prefix);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * Projects that exist, by prefix.
 *
 * A folder counts only once it holds a state file: a directory left behind by a
 * half-finished delete, or created by hand, is not a project and should not
 * appear in a list of them.
 */
export function listProjects(workDir) {
    const root = path.join(workDir, PROJECTS_DIR);
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .filter(name => fs.existsSync(path.join(root, name, 'state.json')));
}
