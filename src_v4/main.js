import fs from 'fs';
import path from 'path';
import { ProjectState } from './core/state_manager.js';
import { splitTextIntoChunks } from './core/tokenizer.js';
import { runExtractionStage } from './stages/01_extraction.js';
import { runConsolidationStage } from './stages/02_consolidation.js';
import { runTranslationLoopStage } from './stages/translation_loop.js';
import { llmManager } from './core/llm_client.js';
import { usageTracker } from './core/usage_tracker.js';
import { assembleBookText } from './core/book_assembler.js';
import config from './config.js';

function reportUsage() {
    const report = usageTracker.formatReport();
    if (report) console.log('\n' + report);
}

async function main() {
    const args = process.argv.slice(2);
    const stageArg = args.find(a => a.startsWith('--stage='));
    const fileArg = args.find(a => a.startsWith('--file='));
    const modelArg = args.find(a => a.startsWith('--model='));
    const langArg = args.find(a => a.startsWith('--lang='));
    const suffixArg = args.find(a => a.startsWith('--suffix='));

    if (!stageArg || !fileArg) {
        console.error('Usage: node src_v4/main.js --stage=<1|2|export> --file=<path/to/book.txt> [--model=google|local|groq] [--lang=<язык>] [--suffix=<код>]');
        console.error('  --file is always required to identify the project.');
        console.error('  --lang / --suffix override the target language and output suffix from config.js (set once at Stage 1).');
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

    // Language settings precedence: CLI flag > existing metadata > config.js default.
    // A flag is persisted into metadata so the chosen value sticks for later stages.
    state.data.metadata = state.data.metadata || {};
    if (langArg) state.data.metadata.targetLanguage = langArg.split('=').slice(1).join('=');
    if (suffixArg) state.data.metadata.langSuffix = suffixArg.split('=')[1];

    // Initial Setup for Stage 1
    if (stage === '1' && state.getChunks().length === 0) {
        if (!fs.existsSync(filePath)) {
            console.error(`[Error] File not found: ${filePath}`);
            process.exit(1);
        }

        console.log(`[Init] Reading file ${filePath}...`);

        // Save source filename to metadata for export later
        state.data.metadata.sourceFile = filePath;
        state.data.metadata.filePrefix = filePrefix;
        // Seed language defaults for a brand-new project (flags above take priority).
        state.data.metadata.targetLanguage = state.data.metadata.targetLanguage || config.translation.targetLanguage;
        state.data.metadata.langSuffix = state.data.metadata.langSuffix || config.translation.langSuffix;
        console.log(`[Init] Target language: "${state.data.metadata.targetLanguage}" → suffix "_${state.data.metadata.langSuffix}.txt" (prompts: ${config.translation.promptLang}).`);

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

    // Output goes to txt/ directory with the project's language suffix.
    const txtDir = path.join(state.workDir, 'txt');
    const prefix = state.filePrefix || 'RESULT_V4';
    const suffix = state.data.metadata?.langSuffix || config.translation.langSuffix;
    const outputPath = path.join(txtDir, `${prefix}_${suffix}.txt`);

    console.log(`[Export] Assembling ${chunks.length} chunks to: ${outputPath}`);

    const { text, missing } = assembleBookText(chunks, llmManager.getModelName());
    fs.writeFileSync(outputPath, text);

    console.log(`--- SYSTEM: Book Assembled to ${outputPath} ---`);
    if (missing > 0) {
        console.warn(`WARNING: ${missing} chunks were missing translations.`);
    }
}

main();
