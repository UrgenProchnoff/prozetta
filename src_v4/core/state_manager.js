import fs from 'fs';
import { usageTracker } from './usage_tracker.js';
import { projectPaths, ensureProjectDir } from './paths.js';

/**
 * What the translation writes onto a chunk. Everything else — the source text, its token
 * count, the extracted terms and status, which model refused it — belongs to the
 * chunk and must survive a reset of the translation.
 *
 * A deny-list on purpose. This used to be an allow-list, rebuilding every chunk
 * as {original, extracted_terms, extraction_status}, and so it silently dropped
 * whatever the rest of the pipeline had added since it was written. Measured on
 * Morphotrophic: all 169 chunks lost `tokens`, and the whole-book budget guards
 * fell back to counting characters — 8.6% out. `blocked_by` went the same way,
 * turning "refused by this model" into "refused by nobody in particular".
 *
 * An allow-list has to be revisited every time a field is added anywhere else.
 * It was not, twice. A deny-list only has to be revisited when the translation itself
 * grows a field, which is where the person editing the translation is already looking.
 */
export const TRANSLATION_FIELDS = [
    'translation',
    'translationTokens',
    'translation_status',
    'translation_blocked_by',
    'history',
    'dispute',
    // Advice accepted from the whole-book review, waiting for the next run to
    // act on it. It describes a translation that a reset is about to delete.
    'advice',
];

/** A copy of `chunk` with the translation's output removed, nothing else touched. */
export function withoutTranslation(chunk) {
    const clean = { ...chunk };
    for (const field of TRANSLATION_FIELDS) delete clean[field];
    return clean;
}

export class ProjectState {
    constructor(workDir, filePrefix) {
        this.workDir = workDir || process.cwd();
        this.filePrefix = filePrefix || '';

        // Everything about one book lives in projects/<book>/ — see core/paths.js
        // for why the answer is given in exactly one place.
        const paths = projectPaths(this.workDir, this.filePrefix);
        this.projectDir = paths.dir;
        this.stateFile = paths.state;
        this.glossaryFile = paths.glossary;
        // The passport lives beside the glossary rather than inside the state:
        // both are human-edited artefacts, and neither should be lost when
        // the translation is reset.
        this.passportFile = paths.passport;
        // The model's glossary findings. Kept apart from the glossary itself
        // because nothing here is applied automatically: the file is a report
        // about the glossary, not a version of it.
        this.glossaryReviewFile = paths.review;
        // The book model's reading of the finished translation. Apart from the
        // state for the same reason as the glossary review: it is a report about
        // the translation, not a version of it.
        this.translationReviewFile = paths.translationReview;

        this.data = {
            metadata: {
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                currentStage: 'init',
                filePrefix: this.filePrefix,
            },
            chunks: []
        };
    }

    load() {
        if (fs.existsSync(this.stateFile)) {
            try {
                const raw = fs.readFileSync(this.stateFile, 'utf-8');
                this.data = JSON.parse(raw);
                console.log(`[State] Loaded project state from ${this.stateFile}`);
                console.log(`[State] Total chunks: ${this.data.chunks.length}`);
                // Seed the usage tracker with spend already recorded for this project
                // so this run accumulates on top of it instead of resetting.
                usageTracker.setBaseline(this.data.metadata?.usage);
            } catch (e) {
                console.error(`[State] Error loading state file: ${e.message}`);
                throw e;
            }
        } else {
            console.log(`[State] No existing state found, starting fresh.`);
        }
    }

    save() {
        this.data.metadata.updatedAt = new Date().toISOString();
        // Persist accumulated LLM spend (baseline + this session) for the GUI.
        if (usageTracker.hasData || usageTracker.hasBaseline) {
            this.data.metadata.usage = usageTracker.snapshot();
        }
        // The folder may not exist yet: a fresh project writes its state before
        // anything else has had reason to create it.
        ensureProjectDir(this.workDir, this.filePrefix);
        const tempFile = this.stateFile + '.tmp';

        try {
            fs.writeFileSync(tempFile, JSON.stringify(this.data, null, 2));
            fs.renameSync(tempFile, this.stateFile);
            // console.log(`[State] Saved state atomically.`);
        } catch (e) {
            console.error(`[State] Error saving state: ${e.message}`);
            throw e;
        }
    }

    getGlossaryPath() {
        return this.glossaryFile;
    }

    getPassportPath() {
        return this.passportFile;
    }

    getGlossaryReviewPath() {
        return this.glossaryReviewFile;
    }

    getTranslationReviewPath() {
        return this.translationReviewFile;
    }

    getChunks() {
        return this.data.chunks;
    }

    setChunks(chunks) {
        this.data.chunks = chunks;
    }

    updateChunk(index, data) {
        if (!this.data.chunks[index]) {
            throw new Error(`Chunk index ${index} out of bounds`);
        }
        this.data.chunks[index] = { ...this.data.chunks[index], ...data };
    }
}
