import fs from 'fs';
import path from 'path';
import { ProjectState } from '../core/state_manager.js';

// Simple script to reset project state to "After Stage 1"
// This keeps 'extracted_terms' but removes 'translation', 'translation_status', and 'history'.
// Usage: node src_v4/tools/reset_to_stage1.js --file=txt/book.txt

async function resetToStage1() {
    console.log('--- RESET TOOL: Reverting to Post-Stage 1 State ---');

    const args = process.argv.slice(2);
    const fileArg = args.find(a => a.startsWith('--file='));

    if (!fileArg) {
        console.error('Usage: node src_v4/tools/reset_to_stage1.js --file=<path/to/book.txt>');
        process.exit(1);
    }

    const filePath = fileArg.split('=')[1];
    const fileExt = path.extname(filePath);
    const filePrefix = path.basename(filePath, fileExt);

    // Initialize state manager with prefix
    const workDir = process.cwd();
    const state = new ProjectState(workDir, filePrefix);
    state.load();

    const chunks = state.getChunks();
    console.log(`Loaded ${chunks.length} chunks for project "${filePrefix}".`);

    // Backup first
    const backupPath = path.join(workDir, `${filePrefix}_project_state_before_reset.json.bak`);
    fs.copyFileSync(state.stateFile, backupPath);
    console.log(`Backup saved to: ${backupPath}`);

    // Modify chunks
    let modifiedCount = 0;
    const cleanChunks = chunks.map(chunk => {
        // Create a new object preserving explicit fields we want from Stage 1
        // We want: original, extracted_terms, extraction_status (if exists)
        // We explicitly DROP: translation, translation_status, history, etc.

        const newChunk = {
            original: chunk.original,
            extracted_terms: chunk.extracted_terms, // Stage 1 output
            extraction_status: chunk.extraction_status, // Stage 1 status
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
    }

    state.save();
    console.log(`Reset complete. Cleared translation data from ${modifiedCount} chunks.`);
    console.log(`${filePrefix}_project_state.json is now ready for a fresh Stage 2 run.`);
}

resetToStage1().catch(e => console.error(e));
