import fs from 'fs';
import path from 'path';
import { ProjectState } from './core/state_manager.js';
import { splitTextIntoChunks } from './core/tokenizer.js';
import { runExtractionStage } from './stages/01_extraction.js';
import { runConsolidationStage } from './stages/02_consolidation.js';
import { runTranslationLoopStage } from './stages/translation_loop.js';
import { llmManager } from './core/llm_client.js';
import { usageTracker } from './core/usage_tracker.js';

function reportUsage() {
    const report = usageTracker.formatReport();
    if (report) console.log('\n' + report);
}

async function main() {
    const args = process.argv.slice(2);
    const stageArg = args.find(a => a.startsWith('--stage='));
    const fileArg = args.find(a => a.startsWith('--file='));
    const modelArg = args.find(a => a.startsWith('--model='));

    if (!stageArg || !fileArg) {
        console.error('Usage: node src_v4/main.js --stage=<1|2|export> --file=<path/to/book.txt> [--model=google|local|groq]');
        console.error('  --file is always required to identify the project.');
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
    const filePath = fileArg.split('=')[1];

    // Derive prefix from filename: "txt/Sterling_Junk_DNA.txt" → "Sterling_Junk_DNA"
    const fileExt = path.extname(filePath);
    const filePrefix = path.basename(filePath, fileExt);

    console.log(`[Init] Project prefix: "${filePrefix}"`);

    // Ensure txt/ directory exists
    const txtDir = path.join(process.cwd(), 'txt');
    if (!fs.existsSync(txtDir)) {
        fs.mkdirSync(txtDir, { recursive: true });
        console.log(`[Init] Created txt/ directory.`);
    }

    // Initialize State with file prefix
    const state = new ProjectState(process.cwd(), filePrefix);
    state.load();

    // Initial Setup for Stage 1
    if (stage === '1' && state.getChunks().length === 0) {
        if (!fs.existsSync(filePath)) {
            console.error(`[Error] File not found: ${filePath}`);
            process.exit(1);
        }

        console.log(`[Init] Reading file ${filePath}...`);

        // Save source filename to metadata for export later
        state.data = state.data || {};
        state.data.metadata = state.data.metadata || {};
        state.data.metadata.sourceFile = filePath;
        state.data.metadata.filePrefix = filePrefix;

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
                state.save(); // flush token-usage stats (consolidation writes only the glossary)
                console.log('\n=== STAGE 1 COMPLETE ===');
                reportUsage();
                console.log(`Now please MANUALLY REVIEW and EDIT "${path.basename(state.getGlossaryPath())}" to ensure terms are correct.`);
                console.log(`Once finished, run: node src_v4/main.js --stage=2 --file=${filePath}`);
                break;
            case '2':
                await runTranslationLoopStage(state);
                reportUsage();
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

    // Output goes to txt/ directory with _rus suffix
    const txtDir = path.join(state.workDir, 'txt');
    const prefix = state.filePrefix || 'RESULT_V4';
    const outputPath = path.join(txtDir, `${prefix}_rus.txt`);

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

    // Disclaimer at the end of the book.
    const modelName = llmManager.getModelName();
    const disclaimer =
        `\n\n---\n` +
        `Перевод сделан проектом prozetta — помощник переводчика.\n` +
        `Модель: ${modelName}.\n` +
        `GitHub: <ссылка будет добавлена позже>\n`;
    fs.appendFileSync(outputPath, disclaimer);

    console.log(`--- SYSTEM: Book Assembled to ${outputPath} ---`);
    if (missing > 0) {
        console.warn(`WARNING: ${missing} chunks were missing translations.`);
    }
}

main();
