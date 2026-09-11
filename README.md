# prozetta

*Prose + Rosetta* — an LLM pipeline for **literary translation** that keeps names and
terminology consistent across an entire book and self-checks its own quality.

🇷🇺 [Русская версия](README.ru.md)

> 🚀 **Start here:** run `start.bat` (Windows) or `./start.sh` (macOS/Linux). It
> installs what it needs on the first run and opens the web interface in your
> browser. There is also a [step-by-step beginner guide](docs/GUIDE.en.md):
> installation, a free Google API key, a first translation, and everything from
> there to a finished FB2. It is in the program too, first in **? Help**.

Most machine translation handles a chapter in isolation, so a character called
*Wei Ying* drifts into *Weiying* and *Young Master Wei* a hundred pages later.
prozetta reads the whole book first and translates second.

Its answer to that is not one trick but a shape: **things that can only be decided
once for a whole book are decided once, in one place, and then handed to every
chunk.** Who narrates. Whether characters address each other formally. What gender
a minor character is. How a term is spelled. None of these can be worked out from
inside a single chunk, and all of them go wrong when each chunk decides for
itself.

Nothing a model proposes is applied on its own. The glossary is a draft you
correct; every finding of every review is a decision you make. The program's job
is to find the questions and to make each one cheap to answer.

## Getting started

```bash
start.bat          # Windows
./start.sh         # macOS, Linux
```

Either one installs dependencies on the first run, starts the server and opens
`http://127.0.0.1:3457`. The port is set by `GUI_PORT`; the server binds to
`127.0.0.1` and listens to nothing else.

You need **Node.js**, and a model to translate with — one of:

- a **local** OpenAI-compatible server (LM Studio, Ollama, llama.cpp, vLLM). No
  key, no cost, and no content filter, which is the only way to finish a book
  whose chunks a cloud model refuses;
- **Google**, whose free tier is enough for a whole book — a key from AI Studio;
- **Groq**, also with a free tier;
- anything else reachable over the OpenAI protocol.

Keys are entered on the Settings page and stored in
`src_v4/config.overrides.json`, which is gitignored.

## What the interface does

Eight screens, each with a **? Help** button that opens an article about it: what
is on the screen, what it is for, and what to do in the usual cases. The same
articles are in `docs/`.

**[Projects](docs/PROJECTS.en.md)** — every book you have loaded. Upload a `.txt`
(the encoding is detected and converted to UTF-8) or drop files into `txt/`.
Translating a book into a second language reuses the chunking and the extracted
terms, which is the expensive part.

**[Monitor](docs/MONITOR.en.md)** — one book's main screen: the seven-step
pipeline with a line under each step saying where it stands, one sentence naming
what to do next, and a Start button that does exactly that. Below it, a map of the
book: one cell per chunk, coloured by state, marked in the corners for chunks a
filter refused or the review wants changed, each cell a click away from its text.

**[Glossary](docs/GLOSSARY.en.md)** — the term list as a table rather than JSON:
search, type, gender, notes, and how many chunks each term actually occurs in
(zero means it was invented or misrecorded). It also groups entries that are forms
of one word — `replenisher` against `replenishers` — which is where a book quietly
starts calling one thing three names.

**[Passport](docs/PASSPORT.en.md)** — the decisions that hold for a whole book:
narrative person and tense, the form of address, the cast with their genders and
dossiers, how direct speech is set. Built by one call over the entire text, then
corrected by hand.

**[Chunk editor](docs/CHUNK.en.md)** — original and translation side by side, with
the review's findings for this chunk above them; a finding's button selects its
quote in the editable text. **Ctrl+Shift+F** searches every chunk at once, in the
translation or the original, and replaces across the book with a single undo.

**[History](docs/HISTORY.en.md)** — everything that has changed the translation,
newest first, filtered by kind of change. Opening a row shows the change itself,
word by word. Every change can be undone, and the undo is recorded rather than
erased, so it can be undone in its turn.

**[Book](docs/BOOK.en.md)** — assembles FB2 with a cover, title, author and a
table of contents found from the headings in the text.

**[Settings](docs/SETTINGS.en.md)** — which model does which job, and how to reach
it. Two jobs: a **main model** that translates and checks chunk by chunk, where
price and speed matter, and a **book model** for the handful of calls that read
the entire book, where depth does.

## How a book gets translated

1. **Extraction** reads the book in chunks and pulls out names, places and terms.
2. **Glossary** consolidates them into one list for you to correct.
3. **Glossary review** — one call over the whole book, saying what the list gets
   wrong. Findings are proposals; you accept or reject each.
4. **Passport** — the whole-book decisions, above.
5. **Translation** — chunk by chunk through **translate → review → decide →
   fix/redraft**, with the glossary and the passport as ground truth.
6. **Translation review** — one call over the finished text, finding what no chunk
   could see: a broken register, terms that disagree, a joke that went missing.
   Accepted findings are queued onto their chunks and applied by the next
   translation run.
7. **Export** — the book, as text or FB2.

Steps 3, 4 and 6 read the entire book in a single call. What limits them is not
the model's context window but the **quota on input tokens per minute** — measured
on Gemini's free tier, calls of ~167,000 tokens go through and ~195,000 are
refused. So each of them can also be run by hand: the program builds the prompt,
you paste it into a web console where the window is a million tokens and no API
key is needed, and paste the answer back. It passes exactly the same checks — and
by that route the **original** can be sent alongside the translation, which finds
errors of meaning the translation alone cannot show.

### The review loop, chunk by chunk

| Review result            | Action                          |
|--------------------------|---------------------------------|
| score ≥ 9.1 and `like=1` | ✅ **Accepted** — saved          |
| score ≥ 7.5 and `like=1` | 🔧 **Fix** — correct the errors  |
| score < 7.5 or `like=0`  | 🔄 **Redraft** — translate anew  |

Ten iterations per chunk at most; the best attempt is kept if they run out. A run
that is interrupted resumes where it stopped. A chunk the two sides cannot agree
on is marked disputed and left for a human rather than burning the budget.

## Command line

Everything the interface does, the CLI does too — it is the same pipeline, and the
GUI runs these very commands.

```bash
node src_v4/main.js --stage=<extract|glossary|passport|translate|review|export> --file=txt/My_Book.txt [--model=google|local|groq]
```

`--file` is required at every stage. It identifies the project: the source, the
prefix of its state and glossary files, and the output name — which is what lets
several books run in parallel, each with its own state.

```bash
# Extract terms and build the glossary
node src_v4/main.js --stage=extract --file=txt/My_Book.txt --model=google

# Review the glossary against the whole book (writes findings, applies nothing)
node src_v4/main.js --stage=glossary --file=txt/My_Book.txt

# Build the book passport
node src_v4/main.js --stage=passport --file=txt/My_Book.txt

# Translate
node src_v4/main.js --stage=translate --file=txt/My_Book.txt --model=google

# Review the finished translation (writes findings, changes nothing)
node src_v4/main.js --stage=review --file=txt/My_Book.txt

# Assemble whatever is translated, complete or not
node src_v4/main.js --stage=export --file=txt/My_Book.txt
```

Target language is set at extraction and then fixed for the project:

```bash
node src_v4/main.js --stage=extract --file=txt/My_Book.txt --lang=English --suffix=en
# later stages assemble txt/My_Book_en.txt
```

Cloud keys come from the environment when running this way:

```bash
export GOOGLE_API_KEY="your_key"
export GROQ_API_KEY="your_key"
```

### Tools

```bash
node src_v4/tools/reset_to_stage1.js --file=txt/My_Book.txt   # drop translations, keep what extraction found
npm run i18n        # interface strings: both languages present, none dead
npm run routes      # every call the interface makes has a route to answer it
npm run changelog   # every commit is recorded, in both languages
```

## Configuration

Models and pipeline parameters live in [src_v4/config.js](src_v4/config.js);
anything changed in the GUI is written to `src_v4/config.overrides.json` and
applied at the next stage run.

Worth knowing:

- **approve at ≥ 9.1, fix at ≥ 7.5, redraft below** — the review loop's thresholds.
- **bookCallTokenBudget** — the ceiling for a whole-book call, 170,000 by default.
  This is a quota, not a context window; change it if your provider's differs.
- **targetLanguage / langSuffix** — the default language to translate into and the
  exported file's suffix. Written into the prompt as a string, so spell it the way
  `promptLang` expects (`немецкий` for `ru`, `German` for `en`).
- **promptLang** — the language of the instructions given to the model, `ru` or
  `en`. Not the target language.

Precedence for the language: **CLI flag → project metadata → config.js**.

**Models.** `gemma4-26b-a4b` and larger do well as the main model. With the
default ~1k-token chunks, give a reasoning model ~32k of context: the chunk, the
glossary extract and the reasoning trace all need room.

## Project layout

```
src_v4/                # The pipeline
  main.js              # CLI entry point
  config.js            # Models and pipeline parameters
  prompts.js           # What the models are told
  stages/              # 01_extraction, 02_consolidation, 03_passport,
                       # 04_glossary_review, 05_translation_review, translation_loop
  core/                # llm_client, state_manager, tokenizer, passport, pov_map,
                       # glossary_review, translation_review, quoted_spans, text_diff,
                       # dialogue, book_call, book_assembler, usage_tracker
  tools/               # reset_to_stage1, and the checks: i18n, routes, changelog
  utils/               # parsers, rate_limiter
src_gui/               # The web interface, over the same pipeline
  server.js            # API and static files
  web/                 # app.js, i18n.js, style.css
docs/                  # The help articles, one per screen
projects/<book>/       # One folder per book: state, glossary, passport, reviews (gitignored)
txt/                   # Source texts and output (gitignored)
```

A book's own files never enter git. `projects/`, `txt/`, `config.overrides.json`
and `.env` are all ignored — one ignored directory per book rather than a pattern
per file type, because a new kind of artifact used to default to *not* ignored,
which is how a copyrighted translation nearly got committed.

## License

[MIT](LICENSE).
