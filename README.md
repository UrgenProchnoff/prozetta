# prozetta

*Prose + Rosetta* — an LLM pipeline for **literary translation** that keeps names and
terminology consistent across an entire book and self-checks its own quality.

🇷🇺 [Русская версия](README.ru.md)

Most machine translation handles a chapter in isolation, so a character called
*Wei Ying* drifts into *Weiying* and *Young Master Wei* a hundred pages later.
prozetta works in two stages to avoid exactly that:

1. **Context preparation** — reads the whole book, splits it into chunks, extracts
   names/terms, and consolidates them into a single glossary you can review and edit.
2. **Smart translation** — translates chunk by chunk through a
   **translate → review → decide → fix/redraft** loop, using the glossary as ground truth.

A web GUI sits on top of the same pipeline for editing the glossary, monitoring
progress, and correcting individual chunks.

## Requirements

1. **Node.js**
2. Install dependencies:
   ```bash
   npm install
   ```
3. An LLM source — either:
   - a **local** OpenAI-compatible server (e.g. llama.cpp / vLLM / LM Studio), or
   - **cloud** providers via API keys:
     ```bash
     export GOOGLE_API_KEY="your_key"   # Google Gemini
     export GROQ_API_KEY="your_key"     # Groq
     ```

## Configuration

Model settings live in [src_v4/config.js](src_v4/config.js):

- **logic_model** — main translation/review model (local server by default)
- **google_model** — Google Gemini
- **groq_model** — Groq

The same file holds pipeline parameters (chunk sizes, retry counts, and the
review thresholds — approve at score ≥ 9.1, fix at ≥ 7.5, redraft below).

### Target language

The `translation` block in [src_v4/config.js](src_v4/config.js) sets the default
**target language**:

- **targetLanguage** — the language to translate *into* (free-form string, e.g.
  `немецкий` or `English`). Defaults to `русский` (Russian).
- **langSuffix** — suffix of the exported file: `<prefix>_<suffix>.txt`. Defaults to `rus`.
- **promptLang** — language of the model **instructions** (the prompt templates), not
  the target. `ru` or `en`.

The language is fixed for a project at Stage 1 and stored in its
`*_project_state.json`. Precedence: **CLI flag → project metadata → config.js**.
In the GUI, `promptLang` and the default language are set on the Settings page, while
the per-project target language/suffix are set on the Monitor when starting Stage 1.

> The target language is injected into the prompts as a string, so write it in the form
> that fits `promptLang` (e.g. `немецкий` for `ru`, `German` for `en`).

**Recommended models.** `gemma4-26b-a4b` and larger give good results as the
logic model. With the default ~1k-token chunks, give reasoning models ~32k tokens
of context — the chunk, the glossary, and the review/reasoning trace need headroom.

## Quick start

```bash
# Stage 1 — build the glossary (pick a provider with --model, default is local)
node src_v4/main.js --stage=1 --file=txt/My_Book.txt --model=google

# Review & edit My_Book_glossary.json (or use the GUI), then:

# Stage 2 — translate (auto-exports txt/My_Book_<suffix>.txt on completion)
node src_v4/main.js --stage=2 --file=txt/My_Book.txt --model=google
```

`--model` accepts `local` (default), `google`, or `groq`.

To translate into a language other than the config.js default, pass `--lang` and
`--suffix` at **Stage 1** (the language is then fixed for the project):

```bash
node src_v4/main.js --stage=1 --file=txt/My_Book.txt --lang=English --suffix=en
# Stage 2 will assemble txt/My_Book_en.txt
```

### The `--file` flag

`--file` is **required at every stage**. It identifies the project: the source
file, the prefix for `<prefix>_project_state.json` and `<prefix>_glossary.json`,
and the output filename. This lets you run **several books in parallel**, each
with its own independent state.

### Stage 2 review loop

Every chunk runs through: **translate → review → decide → fix/redraft**.

| Review result            | Action                          |
|--------------------------|---------------------------------|
| score ≥ 9.1 and `like=1` | ✅ **Accepted** — saved          |
| score ≥ 7.5 and `like=1` | 🔧 **Fix** — correct the errors  |
| score < 7.5 or `like=0`  | 🔄 **Redraft** — translate anew  |

Max 10 iterations per chunk; the best attempt is kept if attempts run out.
An interrupted run resumes from where it stopped.

## GUI

A web interface over the same pipeline (the CLI keeps working as before):

```bash
npm run gui
```

Open `http://127.0.0.1:3457` (port configurable via `GUI_PORT`; the server binds
to `127.0.0.1` only). Features:

- **Dashboard** — all projects with progress; new books from `txt/`.
- **Glossary** — table editor instead of hand-editing JSON: search, types, gender,
  notes, and a per-term occurrence counter (0 = deletion candidate).
- **Monitor** — start/stop stages, pick the target language and suffix for a new
  project (at Stage 1), live log, color-coded chunk map.
- **Chunk** — original and translation side by side, manual editing, accept/reset,
  and the full attempt history with scores.

## Extra tools

```bash
# Force-export whatever is already translated, even if incomplete
node src_v4/main.js --stage=export --file=txt/My_Book.txt

# Reset Stage 2, keeping Stage 1 results (backs up current state first)
node src_v4/tools/reset_to_stage1.js --file=txt/My_Book.txt
```

## Project layout

```
src_v4/                     # Core pipeline
  main.js                   # CLI entry point
  config.js                 # Model & pipeline settings
  core/                     # llm_client, state_manager, tokenizer
  stages/                   # 01_extraction, 02_consolidation, translation_loop
  tools/reset_to_stage1.js  # Reset translations
  utils/                    # parsers, rate_limiter
src_gui/                    # Web GUI over the same pipeline
txt/                        # Source texts & output (gitignored)
```

State files (`*_project_state.json`, `*_glossary.json`) and `txt/` are gitignored —
your texts and glossaries stay local.

## License

[MIT](LICENSE).
