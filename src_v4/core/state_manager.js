import fs from 'fs';
import { usageTracker } from './usage_tracker.js';
import { projectPaths, ensureProjectDir } from './paths.js';

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
        // Stage 2 is reset.
        this.passportFile = paths.passport;
        // The model's glossary findings. Kept apart from the glossary itself
        // because nothing here is applied automatically: the file is a report
        // about the glossary, not a version of it.
        this.glossaryReviewFile = paths.review;

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
