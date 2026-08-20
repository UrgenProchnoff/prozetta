# Changelog

Notable changes to prozetta. Newest first — both the sections and the entries
inside them.

Entries written from this wave onward open with the fingerprint of their commit:
a link in the interface, an argument to `git show 5bba425` in a terminal. The
1.0.0 section predates the practice and carries none.

## Unreleased — quality wave

Everything in this section is about one thing: a translation that stays
consistent about who is speaking, who they are, and what they are called.

**2026-08-20**

- `3d054dc` — The passport stage no longer discards its own token spend: it wrote the
  passport to its own file and never saved the project state, so the call
  reached the run report and vanished from the statistics.

**2026-08-18**

- `0b8f31a` — Project working files moved out of the root into `projects/<book>/`,
  one folder per book. Paths are resolved in one place, deleting a project is
  removing a directory, and .gitignore is one line instead of six patterns.
  `npm run migrate` moves an existing installation.
- `ce3253f` — One direction for the whole file: newest first, in the sections and in
  the entries inside them.
- `683c5b3` — The changelog became a list of commits, one line each, and `npm run
  changelog` checks that every commit has a line, every link resolves, and the
  order holds.
- `7ca87e0` — Every changelog entry is tied to its commit, and the fingerprint
  became a link.
- `16ec5f1` — Both roles — main and large model — are asked the same way: a card
  with a provider dropdown, above the provider cards with their tests and
  highlighting.
- `ba4696b` — Pipeline settings are grouped by question, and fields say when a
  change bites: new books only, or from the next run.
- `3e1cf3f` — A Simple view with fourteen fields and a readiness panel answering
  “can I translate a book yet”.
- `6074a7f` — All 41 settings fields are named in plain language and explained in
  a sentence. The label used to be the config key, and half the fields had no
  explanation at all.
- `39a22e3` — An explicit switch for the large model and a settings section of its
  own, with an OpenAI-compatible slot, a Test button, and connection failures
  explained in words.
- `94199ec` — Dossiers reach the prompt whole: 600 tokens instead of 500
  characters. The old limit truncated every cast dossier, not merely the long
  ones.
- `bbb6f04` — The footer is aligned, and passport dossiers show in full.

**2026-08-17**

- `ccee337` — The changelog in Russian and English, following the interface
  language.
- `a368e68` — The running version and commit in the footer of every page, plus
  this file.
- `0056ced` — The glossary review runs from the editor. The button is blocked
  while findings are outstanding, edits are unsaved, or the call would not fit
  the budget.
- `98c07d6` — Glossary notes wrap to their full height instead of a single-line
  field hiding two thirds of a dossier.
- `bdfab34` — Findings are matched to entries by text rather than row number, and
  rejections are remembered. Deleting one row no longer discards the review of
  the others.
- `691f5de` — Findings that failed verification are kept verbatim with the check
  each failed. Nothing reads them — they are there so that how far they can be
  trusted becomes answerable from accumulated runs.
- `d308eb4` — Glossary review by the book model: one call carrying the whole book
  and the whole glossary. Every finding must quote the book — an unverifiable
  one is dropped. Nothing is applied automatically.
- `e7a7dd7` — The language profile is derived once per text rather than once per
  glossary entry. Opening a large glossary: 8.9 s → 0.9 s.
- `275f25e` — Entries shorter than four characters are no longer flagged. The rule
  made sense under substring matching and now buried findings under the book's
  main characters: flagged rows 56 → 16.
- `2f3f833` — The book passport became visible and editable in the GUI, with the
  point-of-view map drawn as a strip.
- `366797c` — Character gender and notes now ride in the cheat sheet, with a guard
  against entries that contradict themselves.
- `be8a795` — Glossary findings refresh on save instead of requiring F5.
- `2e9881f` — “Untranslated” is separated from real defects: leaving Latin is a
  transliteration decision, not a mistake, and those entries outnumber the
  defects.
- `50fdc40` — Nested names are flagged only when the shared part is spelled two
  ways. Nesting itself is normal: a book says both “Roger Coolidge” and
  “Coolidge”.
- `d07fa62` — Hygiene findings appear in the glossary editor, where they can be
  acted on, rather than only in a console report.
- `280ed36` — Glossary hygiene no longer overwrites an existing backup — a
  799-entry original was lost to that once.
- `b1dc19c` — An unknown language is learned from the book model and validated
  against the text by eight checks before it is believed. Failing them, it stays
  honestly unsupported.
- `50325a0` — The language is identified, not just the script. Polish read as
  English: `\b(i|me|my)\b` matched the Polish word for “and” 123 times. Russian
  pronoun tables also stopped counting zero — JavaScript's `\b` is defined over
  ASCII.

**2026-08-16**

- `93c9446` — The text is re-split on point-of-view boundaries, and the splitter
  drift that added a newline per chunk is fixed.
- `20c1c85` — Document kind: in fiction “you” is the character, in non-fiction the
  reader. Measured on a real manual: avoiding gendered forms would have been
  worse than the human translation.
- `70ae106` — Point-of-view boundaries given by the model as verbatim quotes, as a
  fallback when anchors find nothing. The code locates each quote itself: 36 of
  36, median error 3 characters.
- `3fe7d9a` — A short-lived provider outage is waited out instead of aborting the
  stage.
- `61fc6b7` — The reader's form of address is a bare pronoun; explanations the
  model packed into that field are kept separately.
- `0ceee70` — The dispute flag is visible in the GUI: a chunk the translator and
  reviewer never agreed on is marked.
- `49836c2` — Dossiers of cast members named in a chunk go into the translator's
  prompt, with a pointer to pick the form of address from the relationships in
  them — instead of a pair registry.
- `1e89434` — Tense authority is the original, phrase by phrase, not the passport
  label. All three tense complaints in one run were false, one of them resting
  on a quote the reviewer had altered.
- `e85704c` — The scope of <style> narrowed to the author's narration, and the
  translator/reviewer deadlock broken: a repeated complaint is detected and
  redrafts are capped.
- `0a23143` — Passport decisions are injected into the translate, check and fix
  prompts as <style>. A project without a passport gets byte-identical prompts
  to before.
- `5bba425` — The book passport: one call gives the point-of-view cast and their
  dossiers, while the map itself is computed from names in quoted speech plus
  chapter rotation — 99.4% against 66% for asking a model per segment.
- `c6640a9` — Language profiles keyed by script — the deterministic layer works
  beyond English.
- `f2eb1fc` — A separate client profile for whole-book calls: its own provider,
  which does not follow the model chosen for chunk work.
- `cdba158` — Glossary matching precision and layout fidelity. Terms match on word
  boundaries — 46.5% of cheat-sheet noise gone; the translator is told not to
  re-lay-out paragraphs — exact matches went from 2 of 12 to 10 of 12; a reply
  without the expected tag is retried rather than used; text is split on chapter
  boundaries.

## 1.0.0 — 2026-07-24

First public release.

- Four-stage pipeline: term extraction, glossary consolidation, translate/check/
  fix loop, export.
- Providers: local (llama.cpp), Google, Groq; per-role model settings and a
  model picker for Google with quota handling.
- Web GUI: project dashboard, pipeline roadmap, run monitor with live log,
  glossary editor, settings, token statistics.
- Translation into any target language, with two full sets of prompts.
- Book upload through the interface, project cloning for another language.
- FB2 and plain-text export with chapter detection, metadata and cover.
- Content-filter handling: blocked chunks are diagnosed, skipped, and retried
  with another model.
- Bilingual interface (Russian, English).
