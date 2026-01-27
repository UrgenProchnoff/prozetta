import fs from 'fs';
import path from 'path';
import { ProjectState } from './core/state_manager.js';
import { splitTextIntoChunks } from './core/tokenizer.js';
import { runExtractionStage } from './stages/01_extraction.js';
import { runConsolidationStage } from './stages/02_consolidation.js';
import { runTranslationLoopStage } from './stages/translation_loop.js';
import { llmManager } from './core/llm_client.js';

async function main() {
    const args = process.argv.slice(2);
    const stageArg = args.find(a => a.startsWith('--stage='));
    const fileArg = args.find(a => a.startsWith('--file='));
    const modelArg = args.find(a => a.startsWith('--model='));

    if (!stageArg) {
        console.error('Usage: node src_v4/main.js --stage=<1|2|export> --file=<path/to/book.txt> [--model=google|local]');
        process.exit(1);
    }

    // Set LLM Provider if specified
    if (modelArg) {
        const provider = modelArg.split('=')[1];
        if (provider === 'google' || provider === 'local' || provider === 'groq') {
            llmManager.setProvider(provider);
        } else {
            console.warn(`[Warning] Unknown model provider '${provider}'. Using default (local).`);
        }
    }

    const stage = stageArg.split('=')[1];

    // Initialize State (V4 uses same format but maybe different dir? No, let's keep it compatible)
    // Actually, ProjectState uses process.cwd(). Let's imply we run from root.
    const state = new ProjectState(process.cwd());
    state.load();

    // Initial Setup
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

        // Save source filename to metadata for export later
        state.data = state.data || {};
        state.data.metadata = state.data.metadata || {};
        state.data.metadata.sourceFile = filePath;

        const text = fs.readFileSync(filePath, 'utf-8');
        const chunks = splitTextIntoChunks(text);
        state.setChunks(chunks);
        state.save();
    }

    try {
        switch (stage) {
            case '1':
                console.log('\n=== STAGE 1: CONTEXT PREPARATION ===');
                await runExtractionStage(state);
                console.log('\n--- Starting Consolidation ---');
                await runConsolidationStage(state);
                console.log('\n=== STAGE 1 COMPLETE ===');
                console.log('Now please MANUALLY REVIEW and EDIT "glossary.json" to ensure terms are correct.');
                console.log('Once finished, run: node src_v4/main.js --stage=2');
                break;
            case '2':
                await runTranslationLoopStage(state);
                // Auto-export after translation loop
                exportBook(state);
                break;
            case 'export':
                exportBook(state);
                break;
            default:
                console.error(`Unknown stage: ${stage}`);
        }
    } catch (e) {
        console.error('Fatal Error:', e);
        process.exit(1);
    }
}

function exportBook(state) {
    const chunks = state.getChunks();

    // Determine output filename
    let outputPath = path.join(state.workDir, 'RESULT_V4.txt'); // Default fallback

    if (state.data && state.data.metadata && state.data.metadata.sourceFile) {
        const sourcePath = state.data.metadata.sourceFile;
        const dir = path.dirname(sourcePath);
        const ext = path.extname(sourcePath);
        const name = path.basename(sourcePath, ext);
        outputPath = path.join(dir, `${name}_rus${ext}`);
    }

    console.log(`[Export] Assembling ${chunks.length} chunks to: ${outputPath}`);
    fs.writeFileSync(outputPath, '');

    let missing = 0;
    for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        if (c.translation) {
            fs.appendFileSync(outputPath, c.translation + '\n');
        } else {
            console.warn(`[Export] Chunk ${i} is missing translation.`);
            fs.appendFileSync(outputPath, `[MISSING CHUNK ${i}]\n`);
            missing++;
        }
    }

    console.log(`--- SYSTEM: Book Assembled to ${outputPath} ---`);
    if (missing > 0) {
        console.warn(`WARNING: ${missing} chunks were missing translations.`);
    }
}

main();
