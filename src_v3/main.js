import fs from 'fs';
import path from 'path';
import { ProjectState } from './core/state_manager.js';
import { splitTextIntoChunks } from './core/tokenizer.js';
import { runExtractionStage } from './stages/01_extraction.js';
import { runConsolidationStage } from './stages/02_consolidation.js';
// Placeholders for future stages
import { runTranslationStage } from './stages/03_translation.js';
import { runEvaluationStage } from './stages/04_evaluation.js';

async function main() {
    const args = process.argv.slice(2);
    const stageArg = args.find(a => a.startsWith('--stage='));
    const fileArg = args.find(a => a.startsWith('--file='));

    if (!stageArg) {
        console.error('Usage: node src_v3/main.js --stage=<1|1b|2|3> --file=<path/to/book.txt>');
        process.exit(1);
    }

    const stage = stageArg.split('=')[1];

    // Initialize State
    const state = new ProjectState(process.cwd());
    state.load();

    // Initial Setup (Stage 1 usually needs a file)
    if (stage === '1' && state.getChunks().length === 0) {
        if (!fileArg) {
            console.error('[Error] --file argument is required for initial Stage 1 run.');
            process.exit(1);
        }
        const filePath = fileArg.split('=')[1];
        if (!fs.existsSync(filePath)) {
            console.error(`[Error] File not found: ${filePath}`);
            process.exit(1);
        }

        console.log(`[Init] Reading file ${filePath}...`);
        const text = fs.readFileSync(filePath, 'utf-8');
        const chunks = splitTextIntoChunks(text);
        state.setChunks(chunks);
        state.save();
    }

    try {
        switch (stage) {
            case '1':
                await runExtractionStage(state);
                break;
            case '1b':
                await runConsolidationStage(state);
                break;
            case '2':
                await runTranslationStage(state);
                break;
            case '3':
                await runEvaluationStage(state);
                break;
            default:
                console.error(`Unknown stage: ${stage}`);
        }
    } catch (e) {
        console.error('Fatal Error:', e);
        process.exit(1);
    }
}

main();
