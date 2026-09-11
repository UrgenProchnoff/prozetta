import fs from 'fs';
import path from 'path';
import { ProjectState } from './core/state_manager.js';
import { splitTextIntoChunks } from './core/tokenizer.js';
import { runExtractionStage } from './stages/01_extraction.js';
import { runConsolidationStage } from './stages/02_consolidation.js';
import { runPassportStage } from './stages/03_passport.js';
import { runGlossaryReviewStage } from './stages/04_glossary_review.js';
import { runTranslationReviewStage } from './stages/05_translation_review.js';
import { runTranslationLoopStage } from './stages/translation_loop.js';
import { llmManager } from './core/llm_client.js';
import { usageTracker } from './core/usage_tracker.js';
import { assembleBookText } from './core/book_assembler.js';
import { initFileLog } from './utils/logger.js';
import config from './config.js';

function reportUsage() {
    const report = usageTracker.formatReport();
    if (report) console.log('\n' + report);
}

// The steps are named after the work they do. "1" and "2" are what two of them
// were called back when there were only two, and they still arrive from the
// interface and from anything anybody scripted, so they keep working — as
// spellings of a name, not as a numbering anyone has to learn.
const STAGE_ALIASES = { '1': 'extract', '2': 'translate' };

async function main() {
    const args = process.argv.slice(2);
    const stageArg = args.find(a => a.startsWith('--stage='));
    const fileArg = args.find(a => a.startsWith('--file='));
    const modelArg = args.find(a => a.startsWith('--model='));
    const langArg = args.find(a => a.startsWith('--lang='));
    const suffixArg = args.find(a => a.startsWith('--suffix='));

    if (!stageArg || !fileArg) {
        console.error('Usage: node src_v4/main.js --stage=<extract|glossary|passport|translate|review|export> --file=<path/to/book.txt> [--model=google|local|custom] [--lang=<язык>] [--suffix=<код>]');
        console.error('  --stage=extract reads the book chunk by chunk and pulls out names, places and terms (also accepted as 1).');
        console.error('  --stage=passport reads the whole book at once (book_model profile) and writes <prefix>_passport.json.');
        console.error('  --stage=glossary reviews the glossary against the whole book and writes glossary_review.json (applies nothing).');
        console.error('  --stage=translate is the translation itself, chunk by chunk (also accepted as 2).');
        console.error('  --stage=review reads the finished translation in one call and writes translation_review.json (changes nothing).');
        console.error('  --file is always required to identify the project.');
        console.error('  --lang / --suffix override the target language and output suffix from config.js (set once at extraction).');
        process.exit(1);
    }

    // Set LLM Provider if specified
    if (modelArg) {
        const provider = modelArg.split('=')[1];
        // "custom" is what the card is called; "groq" is what the settings file
        // has called it since there was only one such service, and it still works.
        const named = provider === 'custom' ? 'groq' : provider;
        if (named === 'google' || named === 'local' || named === 'groq') {
            llmManager.setProvider(named);
        } else {
            console.warn(`[Warning] Unknown model provider '${provider}'. Using default (local).`);
        }
    }

    const stage = STAGE_ALIASES[stageArg.split('=')[1]] || stageArg.split('=')[1];
    const filePath = fileArg.split('=')[1];

    // Derive prefix from filename: "txt/Sterling_Junk_DNA.txt" → "Sterling_Junk_DNA"
    const fileExt = path.extname(filePath);
    const filePrefix = path.basename(filePath, fileExt);

    // From here on, everything printed to the console also lands in
    // <prefix>_run.log next to the project state file.
    initFileLog(process.cwd(), filePrefix);

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

    // Bootstrap a fresh project: read the source and split it into chunks.
    // Any LLM stage can do this, so translation works directly (translate without
    // a glossary) — extraction is no longer a prerequisite for chunking. The
    // passport stage needs chunks too: its map is expressed in chunk indices.
    if ((stage === 'extract' || stage === 'translate' || stage === 'passport') && state.getChunks().length === 0) {
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
            case 'extract':
                console.log('\n=== EXTRACTION: CONTEXT PREPARATION ===');
                await runExtractionStage(state);
                console.log('\n--- Starting Consolidation ---');
                await runConsolidationStage(state);
                state.save(); // flush token-usage stats (consolidation writes only the glossary)
                console.log('\n=== EXTRACTION COMPLETE ===');
                reportUsage();
                console.log(`Now please MANUALLY REVIEW and EDIT "${path.basename(state.getGlossaryPath())}" to ensure terms are correct.`);
                console.log(`Once finished, run: node src_v4/main.js --stage=translate --file=${filePath}`);
                break;
            case 'passport':
                await runPassportStage(state);
                // The passport is its own file, so nothing else here writes the
                // project state — and without this the stage's token spend was
                // counted in the run report and then thrown away. It only ever
                // survived when the stage happened to re-split the text, which
                // saves for its own reasons.
                state.save();
                reportUsage();
                break;
            case 'glossary':
                await runGlossaryReviewStage(state);
                state.save();   // flush token-usage stats: the review is its own file
                reportUsage();
                break;
            case 'review':
                await runTranslationReviewStage(state);
                state.save();   // flush token-usage stats: the review is its own file
                reportUsage();
                break;
            case 'translate':
                await runTranslationLoopStage(state);
                reportUsage();
                // Auto-export after translation loop
                exportBook(state);
                break;
            case 'export':
                if (state.getChunks().length === 0) {
                    console.error('[Error] Project has no chunks yet — nothing to export.');
                    process.exit(1);
                }
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
    // Language clones carry the suffix in the prefix (e.g. "book_de" + "de"); avoid
    // doubling it so the filename matches what the GUI download produces.
    const outName = prefix.endsWith(`_${suffix}`) ? `${prefix}.txt` : `${prefix}_${suffix}.txt`;
    const outputPath = path.join(txtDir, outName);

    console.log(`[Export] Assembling ${chunks.length} chunks to: ${outputPath}`);

    const { text, missing } = assembleBookText(chunks, llmManager.getModelName());
    fs.writeFileSync(outputPath, text);

    console.log(`--- SYSTEM: Book Assembled to ${outputPath} ---`);
    if (missing > 0) {
        console.warn(`WARNING: ${missing} chunks were missing translations.`);
    }
}

main();
