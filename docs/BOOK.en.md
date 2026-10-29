# Book: building the FB2

This screen turns the translated text into a file a reader app will open: with a
cover, a title, an author and a table of contents.

## Title and author

They go into the FB2 metadata — what the reader app shows on its shelf. An empty
title is replaced by the project name, but a real one is better: the project name
usually comes from a filename.

## Annotation

The blurb the reader app shows in the book's description — what it is about.
Optional. Every line becomes its own paragraph, so blank lines are not needed.
Below your text the program appends three lines: the project, the model and the
link to the repository — so the file always says what translated it.

## Cover

JPEG or PNG, up to 10 MB. Optional — the book builds without one, the shelf is
just grey.

## Chapters

Two ways.

**Marked by the model** — the "Mark the structure" button in the "Structure for
FB2" card. The program picks the short lines that stand as paragraphs of their own,
and the large model decides which are headings and at what level: part, chapter,
subchapter. The book itself is not sent — only those lines with the paragraphs
either side, around twenty thousand tokens even for a long book. Chapters go inside parts, and a heading
over two lines ("Part One:" / "The Makers") stays one heading. The resulting
contents are shown under the button: a wrong mark is better caught there than in a
reader. If the translation is edited after marking, the card says how many lines
the model has not seen.

**Without marks** headings are guessed by words: "Chapter 7", "Prologue", SHORT
LINES IN CAPS, numbers standing alone. "Part One" is not recognised this way and
stays a paragraph.

Either way, a "* * *" separator becomes a scene break.

## Two buttons

- **⬇ Download FB2** — the book with its cover and contents.
- **⬇ Download TXT** — the translated text, plain.

## When to build

After working through the findings and making your edits. On the monitor the
Export step reads `stale` when the text was edited after the last build — the file
on disk is no longer what is in the project, and it is worth building again.

## What next

The book is built. Correct something later and build again; the old file is
overwritten.
