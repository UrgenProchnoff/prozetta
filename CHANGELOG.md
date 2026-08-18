# Changelog

Notable changes to prozetta. Newest first.

The version shown in the GUI footer also carries the commit it was built from,
so a running instance can always be matched to a line in this file.

## Unreleased — quality wave

Everything in this section is about one thing: a translation that stays
consistent about who is speaking, who they are, and what they are called.

In brackets, the commit that made the change: `git show 5bba425`.

### Book passport

- **New stage `--stage=passport`.** One call over the whole book decides what
  holds for all of it — narration person and tense, how the reader is addressed,
  the point-of-view cast and a dossier for each. Written to
  `<prefix>_passport.json`, injected into every translation prompt as `<style>`.
  A project without a passport gets byte-identical prompts to before.
  (5bba425, 0a23143)
- **Point-of-view map.** Which chunk is seen through whose eyes, computed rather
  than asked for: names in quoted speech as anchors, plus a learned rotation
  prior, resolved with Viterbi. Measured 99.4% on chapter-aligned chunks against
  66% for asking a model per segment. A book with no chapter headings falls back
  to boundaries the model gives as verbatim quotes, which the code then locates
  in the text — 36 of 36 quotes found, median error 3 characters.
  (5bba425, 70ae106, 93c9446)
- **Fiction or non-fiction** decides who "you" is: the focal character, whose
  gender comes from the map, or the reader. Measured on a real manual: avoiding
  gendered forms would have been worse than the human translation, not safer.
  (20c1c85)
- **Editable in the GUI**, with the point-of-view map drawn as a strip. (2f3f833)

### Glossary review by the book model

- **New stage `--stage=glossary`**, and a button in the glossary editor. One call
  carrying the whole book and the whole glossary, which is what Stage 1b never
  had: it builds the glossary in batches of thirty terms that see neither.
  (d308eb4, 0056ced)
- **Every finding must quote the book.** The quote is located in the text before
  the finding is shown; one that cannot be found is dropped. On the first real
  run 3 of 15 findings failed that check. Findings naming an entry that does not
  exist, proposing a form the book never uses, or changing nothing are dropped
  the same way, and all of them are kept in the file for later study.
  (d308eb4, 691f5de)
- **Nothing is applied automatically.** Findings appear under the entry they
  concern, with the quote and buttons to apply, delete, find the duplicate or
  reject. Rejections are remembered, including across a rerun. (d308eb4, bdfab34)
- Findings resolve against the glossary as it stands, so acting on one never
  costs the review of the others. (bdfab34)

### Translation loop

- Glossary terms match on word boundaries instead of anywhere in the text,
  which removed 46.5% of cheat-sheet entries as false positives — and works in
  Chinese, Japanese, Korean and Thai, where a boundary cannot be required.
  (cdba158)
- The translator is told not to re-lay-out paragraphs: exact paragraph match
  went from 2 of 12 to 10 of 12. (cdba158)
- Text is split on chapter boundaries, so a chunk no longer starts mid-chapter.
  (cdba158, 93c9446)
- A model's reasoning can no longer reach the book: a reply without the expected
  tag is retried rather than used. (cdba158)
- **Translator/reviewer deadlock broken.** Repeated identical complaints are
  detected, redrafts are capped, and a chunk that ends in disagreement is
  flagged `disputed` and shown as such in the GUI. (e85704c, 0ceee70)
- The reviewer must quote the original before objecting to a tense, after all
  three tense complaints in one run turned out to be false — one of them
  supported by a quote the reviewer had altered. (1e89434)
- Character gender and notes now ride in the cheat sheet, with a guard against
  entries that contradict themselves. (366797c)
- Dossiers of cast members named in a chunk go into the translator's prompt,
  with a pointer to pick the form of address from the relationships in them.
  (49836c2)
- A dossier reaches the prompt whole, capped at 600 tokens rather than 500
  characters: the old limit truncated every dossier, not merely the long ones.
  (94199ec)
- The reader's form of address is a bare pronoun: explanations the model packed
  into that field are kept separately rather than substituted into the prompt as
  a value. (61fc6b7)
- A short-lived provider outage is waited out instead of aborting the stage.
  (3fe7d9a)
- Whole-book calls run on their own client profile, which does not follow the
  provider chosen for chunk work. (f2eb1fc)

### Language handling

- Profiles are keyed by **language**, not script. Polish was reading as English,
  where `\b(i|me|my)\b` matched the Polish word for "and" 123 times and made a
  third-person book look first-person. (c6640a9, 50325a0)
- Russian pronoun tables counted zero from the day they were written, because
  JavaScript's `\b` is defined over ASCII. Word lists are now compiled through
  one helper so the bug cannot return one regex at a time. (50325a0)
- Curated profiles for en/ru/pl/uk/de/fr/es/it/pt; an unknown language is
  learned once from the book model and validated against the text by eight
  checks before it is saved. An unrecognised language gets no pronoun tables
  rather than English ones. (b1dc19c)

### Glossary hygiene

- New tool reporting entries absent from the book, case duplicates, one name
  spelled two ways, and contradictory genders; `--apply` performs only the fixes
  that cannot be wrong. Findings are shown in the editor, with a
  "flagged / untranslated" filter that refreshes on save.
  (cdba158, 280ed36, d07fa62, 50fdc40, 2e9881f, be8a795)
- Entries shorter than four characters are no longer flagged. The rule made
  sense under substring matching and now only buried real findings under the
  book's main characters. (275f25e)

### Performance

- Opening a large glossary in the editor went from 8.9 s to 0.9 s. The language
  profile was being derived once per glossary entry — 257 scans of the whole
  novel for one answer. (e7a7dd7)

### Interface

- **Settings rewritten to be readable.** All 41 fields were labelled with their
  config key and half carried no explanation at all; each now has a name and a
  sentence saying what it does and what happens if it moves. (6074a7f)
- A Simple view holds only the fourteen fields a person must decide, plus a
  readiness panel that answers "can I translate a book yet" and names what is
  missing. The rest lives under Advanced. (3e1cf3f)
- Pipeline settings are grouped by question: how the book is cut up, how strict
  the review is, how the glossary is built, what limits the large model. Fields
  that change a book mid-way are marked apart from those that cannot touch work
  already done. (ba4696b)
- Both roles — main model and large model — are asked the same way: a card with
  a provider dropdown. Below them the provider cards carry address, key, model
  and a Test button, each showing who uses it. (16ec5f1)
- An explicit switch for whether the large model is used at all. Off, the
  passport and glossary-review steps are removed rather than left looking
  unfinished. The large model gains an OpenAI-compatible slot of its own — its
  own address and key, so a rented endpoint does not disturb the model doing
  chunk work. (39a22e3)
- The running version and commit sit in the footer of every page, linked to this
  file — which exists in English and Russian and follows the interface language.
  (a368e68, ccee337)
- Glossary notes and character dossiers wrap to their full height instead of
  hiding two thirds of the text. (98c07d6, bbb6f04)
- Passport page, dispute badges, glossary issue filters, and a review that can
  be started and read without leaving the editor.
  (2f3f833, 0ceee70, 2e9881f, 0056ced)

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
