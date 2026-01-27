import fs from 'fs';
import path from 'path';
import { ProjectState } from '../core/state_manager.js';

// Simple script to reset project state to "After Stage 1"
// This keeps 'extracted_terms' but removes 'translation', 'translation_status', and 'history'.

async function resetToStage1() {
    console.log('--- RESET TOOL: Reverting to Post-Stage 1 State ---');

    // Initialize state manager
    const workDir = process.cwd();
    const state = new ProjectState(workDir);
    state.load();

    const chunks = state.getChunks();
    console.log(`Loaded ${chunks.length} chunks.`);

    // Backup first
    const backupPath = path.join(workDir, 'project_state_before_reset.json.bak');
    fs.copyFileSync(path.join(workDir, 'project_state.json'), backupPath);
    console.log(`Backup saved to: ${backupPath}`);

    // Modify chunks
    let modifiedCount = 0;
    const cleanChunks = chunks.map(chunk => {
        // Create a new object preserving explicit fields we want from Stage 1
        // We want: original, extracted_terms (if exists)
        // We explicitly DROP: translation, translation_status, history, etc.

        const newChunk = {
            original: chunk.original,
            extracted_terms: chunk.extracted_terms // Stage 1 output
        };

        // Check if we actually changed anything (for logging)
        if (chunk.translation || chunk.history || chunk.translation_status) {
            modifiedCount++;
        }

        return newChunk;
    });

    state.setChunks(cleanChunks);

    // Optional: Reset metadata stage?
    if (state.data.metadata) {
        state.data.metadata.lastReset = new Date().toISOString();
        // Maybe set currentStage back to '1' or 'ready_for_2'? 
        // state.data.metadata.currentStage = '1_complete'; 
    }

    state.save();
    console.log(`Reset complete. Cleared translation data from ${modifiedCount} chunks.`);
    console.log(`project_state.json is now ready for a fresh Stage 2 run.`);
}

resetToStage1().catch(e => console.error(e));
