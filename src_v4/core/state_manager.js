import fs from 'fs';
import path from 'path';

export class ProjectState {
    constructor(workDir) {
        this.workDir = workDir || process.cwd();
        this.stateFile = path.join(this.workDir, 'project_state.json');
        this.data = {
            metadata: {
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                currentStage: 'init',
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
