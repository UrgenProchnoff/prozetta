import fs from 'fs';
import path from 'path';
import { projectDir } from '../core/paths.js';
import { ProjectState, withoutTranslation } from '../core/state_manager.js';

// Simple script to reset project state to "after extraction"
// Removes what the translation wrote (translation, status, history, ...) and keeps
// everything else the chunk carries — the text, its token count, the extracted terms.
// Usage: node src_v4/tools/reset_to_stage1.js --file=txt/book.txt

async function resetToStage1() {
    console.log('--- RESET TOOL: Reverting to the post-extraction state ---');

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
    const backupPath = path.join(projectDir(workDir, filePrefix), 'state_before_reset.json.bak');
    fs.copyFileSync(state.stateFile, backupPath);
    console.log(`Backup saved to: ${backupPath}`);

    // Drop the translation's output and leave the rest of the chunk alone — see
    // TRANSLATION_FIELDS in core/state_manager.js for why this is a deny-list.
    let modifiedCount = 0;
    const cleanChunks = chunks.map(chunk => {
        if (chunk.translation || chunk.history || chunk.translation_status) modifiedCount++;
        return withoutTranslation(chunk);
    });

    state.setChunks(cleanChunks);

    // Optional: Reset metadata stage?
    if (state.data.metadata) {
        state.data.metadata.lastReset = new Date().toISOString();
    }

    state.save();
    console.log(`Reset complete. Cleared translation data from ${modifiedCount} chunks.`);
    console.log(`projects/${filePrefix}/state.json is now ready for a fresh translation run.`);
}

resetToStage1().catch(e => console.error(e));
