# Settings: who translates, and with what

This screen answers two questions: **which model does which job** and **how to
reach it**. Everything else is detail you can leave alone.

At the top is a **Simple / Advanced** switch. Simple shows only what is needed;
the rest — chunk size, how strict the checker is, how many attempts — is under
Advanced.

## Readiness

The first card says in plain words what is missing: "Missing: Google key. Fill it
in and you can start", or "Everything is filled in — you can translate a book."
That is the place to begin.

## Two jobs

**The main model** translates the book chunk by chunk and checks the result. There
is a lot of this work: a book costs hundreds of calls, so price and speed matter
here more than depth.

**The book model** makes the whole-book calls — the passport, the glossary review,
the translation review. There are only a handful, but each one reads the entire
book, and here depth is exactly what matters. It can be turned off: the passport
and the reviews then become unavailable, and translation still runs.

Each job picks a provider from the cards below. The same card can serve both.

## Providers

Where to connect and with what. Filled in once.

- **Google** — a free tier that is enough for a book. Needs a key from AI Studio.
- **Another service** — anything with an OpenAI-compatible interface:
  OpenRouter, Together, NVIDIA NIM, a vLLM of your own. This card has presets: a
  service you have set up can be remembered under a name, and the dropdown
  switches between them.
- **A local model** — through an OpenAI-compatible address (LM Studio, Ollama).
  No key, no money, and **no content filter** — the only way to finish a book whose
  chunks a cloud model refuses.
- **OpenAI-compatible (your own address)** — anything else reachable by that
  protocol.

Every card has a **Test** — it checks that the key and address work and shows the
latency. And **↓ Load models** — which pulls the list of available models with
their context and output limits, marked as reasoning, context-caching or batch.

## Pipeline

Under Advanced: chunk size, how many attempts, the score at which a translation is
accepted, the score below which it is redrafted, the token ceiling for a whole-book
call.

The defaults come from measurement, and are worth changing only if you know what
you are changing. The most meaningful one is the token ceiling, if your provider's
quota differs.

## The program

One checkbox — **"Check for updates"**. Once a day the program asks GitHub
whether a build newer than yours has appeared, and marks the bottom of the page
if one has. Nothing is downloaded and nothing is sent: it is one request to the
place the program itself came from.

The checkbox exists because the program arrives as an archive, and an archive has
no way of learning that a newer one exists. Clear it and the program stops
asking; finding out about new versions is then up to you.

## How they apply

Changes are written to `src_v4/config.overrides.json` and **apply at the next
stage run**. A run already going will not pick them up.

"↺ Reset to defaults" restores the values from `config.js`.

## What next

Key set, test green — go back to the list of books and load your first one.
