# Changelog

Notable changes to prozetta. Newest first — both the sections and the entries
inside them.

Entries written from this wave onward open with the fingerprint of their commit:
a link in the interface, an argument to `git show 5bba425` in a terminal. The
1.0.0 section predates the practice and carries none.

## Unreleased — quality wave

Everything in this section is about one thing: a translation that stays
consistent about who is speaking, who they are, and what they are called.

**2026-08-22**

- `94035a8` — What the first real review runs exposed. A quote can straddle a chunk
  boundary the reviewer never saw — the translation-only prompt is seamless — so
  one found in no single chunk is now located on the joined text. And scope is
  the model's hint rather than its verdict: the bilingual run filed four findings
  under "glossary" whose own wording said the glossary was right and the text
  disobeyed. Anything carrying advice can now be queued on its chunk.
- `6489ad9` — The whole-book prompt can be carried to a console with a bigger window
  by hand: the monitor builds it, hands it over, and takes the answer back
  through exactly the checks an API answer gets. Morphotrophic needs 195,472
  tokens and the free tier refuses about 168,000, so it could not be reviewed at
  all. With a million-token window the original fits too — 355,795 bilingually —
  and the review can then find meaning turned inside out, not only clumsy
  Russian.
- `9745396` — Two of the three whole-book guards were estimating tokens by dividing
  characters by four — 8.6% high on Morphotrophic, harmless against a threshold
  of 250,000 and not against one near the real ceiling. They count now, closely
  enough to set the bar by: the glossary review estimates 167,850 against the
  167,852 the API charged. The budget settles at 170,000.
- `1fe3e97` — The whole-book budget was guarding against the wrong quota. 250,000 is
  the documented per-minute total; what refuses these calls is a lower one over
  input alone. The log brackets it: 167,852 tokens went through, ~195,000 was
  refused four times over eight minutes. The budget is now 165,000, counts the
  instructions it used to leave out, and a 429 on that quota is no longer
  retried — a request larger than the window fails the same however long it
  waits.
- `c9bba51` — The translation review is now shown the passport. It was being asked to
  send findings to a passport it had never seen — and whether a drifting register
  belongs to the passport or to the chunk depends entirely on whether a register
  was ever set. The point-of-view map stays out: it is written in chunk indices
  the reviewer cannot resolve. The rest costs 651 tokens in a 193,400-token
  prompt.
- `7a097ac` — "Assess translation" on the monitor: one call reads the whole finished
  text and reports what a chunk-by-chunk reviewer cannot see — calques, a joke
  gone flat, a voice that drifts. Each finding quotes the translation and the
  code works out which chunk that is, because asked by hand this same review was
  right about all fifteen problems and wrong about where they were. Accepted
  advice goes into the fix prompt and into the checker's, so the pass that
  approves everything can judge the one thing the fix was for.
- `0db9610` — Resetting a project to its post-Stage-1 state no longer drops everything
  the chunk had gained since the tool was written. It rebuilt each chunk from
  three named fields, so Morphotrophic's 169 chunks lost their token counts and
  the whole-book budget guards fell back to counting characters. Now a deny-list
  of what Stage 2 writes, shared with the GUI's reset button, which carried the
  same list and the same defect.
- `c1d938a` — The passport says whether the book names its author or the model merely
  recognised it. Morphotrophic carries a copyright line and checks out; Powrot
  names nobody in 42,656 characters and the answer came from recognition. Both
  may be right, only one is verifiable, and until now they looked identical.
- `b18abf5` — The passport records the author and their gender. Morphotrophic's
  afterword has Greg Egan writing of himself in feminine forms: in a novel the
  narrator owns "I" on every page, and nothing told the translator that the
  matter around the story is the one place where the author does. The
  instruction is fenced to those places — unfenced it would put the author's
  gender on a narrator of the opposite one.
- `9e8f56b` — The style block stopped claiming the book was already set that way. It
  said so when the marker was measured from the translation; settled ahead of
  translation, the claim is false on the first chunk, and the sample beside it
  was never in any book.
- `d15c9cc` — The passport prompt now actually asks about direct speech. The field
  reached the model in the example JSON alone, the only one with no matching
  instruction, while the prompt's opening tells the model to trust the text —
  which is the wrong instruction for the one question that must not be answered
  from the book.
- `68024c1` — The dialogue marker became a norm of the target language, settled before
  translation, instead of something read off the finished text. Measuring makes
  the majority right by definition, so a badly translated book would teach the
  passport its own mistake. Counting now answers only whether the text keeps to
  the norm — and against a norm the book does not follow it reports 17% and 108
  chunks where it used to report 83% and 27.
- `2fe4aeb` — The passport gained how direct speech is set, and the glossary is checked
  for answering one question twice. The marker was seeded by counting the
  translation, which the next commit undoes; the counting itself stays, because
  no table here lists the dash that Russian and Spanish set dialogue with. The
  glossary check ranks groups by how unlike their translations are and leaves
  the verdict to a person: guessing at the morphology of an unknown language is
  how a warning turns into noise.

**2026-08-20**

- `e699ce0` — A chunk the content filter refuses no longer takes the whole book down
  with it. Stage 2 skips it, records which model refused, and carries on;
  another model picks it up on the next run, the same one does not waste a call
  on it. Measured on Morphotrophic, six consecutive runs had died on the same
  two chunks. Stage 1 also stopped spending its full retry budget on a refusal
  that cannot change.
- `6c4635d` — Rebuilding a passport no longer takes back hand corrections silently: an
  edited passport is copied aside first, and the editor asks before spending the
  call.
- `ad7fcb2` — The roadmap now recommends the passport: it was the fourth of six steps
  and the recommendation did not know it, taking a new project straight from
  extraction to translation. Starting Stage 2 without one now asks first.
- `3efd3e5` — Re-splitting on point-of-view boundaries carries extracted terms onto
  the new chunks instead of discarding them. A term is pinned by locating its
  own text inside the chunk it was recorded against; one that is not found goes
  to every overlapping chunk rather than being lost. The splitter also stopped
  appending a newline the book never had — the offsets depend on it.
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
