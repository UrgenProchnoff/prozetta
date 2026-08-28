# Edit history: what changed in the book

Everything that changed the translation, in one list, newest first. The chunk
pages hold this one chunk at a time, which answers "what happened here" and never
"what happened to the book last night".

## A row

Time · chunk number · kind of change · how much longer or shorter the text became.
A replace also shows which words became which.

The chunk number is a link: it opens that chunk's editor.

## Kinds of change

Filter buttons with counts across the top: **all 408 · fixed on the review 161 ·
edited by hand 147 · fix 54 · retranslated 30 · replace 16**.

- **draft** — the chunk's first translation;
- **fix** — the translator corrected the chunk on the reviewer's objection;
- **retranslated** — the reviewer rejected it outright and it was drafted afresh;
- **fixed on the review** — a correction made on advice from the translation
  review;
- **edited by hand** — you changed the text in the editor;
- **replace** — a search-and-replace across the book;
- **undo** — taking one of the above back.

The kinds **add up**: "by hand" plus "replace" is the question "what did I change,
as against what the pipeline changed", and it cannot be asked one kind at a time.
Clicking again clears one, "all" clears them. The counts do not move while you do
this: they are over every row, so they say what is there before you ask.

The choice lives in the URL, so a filtered view can be bookmarked and survives a
reload.

## Checks are not here

A check awards a score to a text it did not touch. There are more of them than
there are real changes, and in one list the changes would be the minority of their
own list. Checks are visible in an individual chunk's history.

## What changed

The button opens the change itself: **struck through in red** what went,
**in green** what came, and the untouched stretches cut down to their ends — "…
2169 characters unchanged …". A chunk is four thousand characters and a change is
usually one word; shown whole, it would be a needle.

The comparison is by words, not characters: a character diff of a replaced word
would mark the letters the two happen to share and leave you assembling the answer
from fragments.

For a replace that touched several chunks, all of them are shown, one section each.

## Undo

Works on any row. On a replace it puts **every touched chunk back at once**: one
action, one undo, not four repairs.

An undo is **recorded rather than erased**. A page whose job is to show what
happened cannot have a way of making things un-happen. So the undo appears in the
list as a row of its own — and can itself be undone.

## What next

Found a bad edit — undo it. Want to fix it yourself — the chunk number leads to
the editor.
