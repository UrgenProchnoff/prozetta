# A chunk: the translation editor

One chunk of the book — around four thousand characters. The original on the left,
the editable translation on the right, and this chunk's whole history below. Every
cell of the monitor's map leads here, and so does every finding of the review.

## The toolbar

`← 23` and `25 →` page through the book. The marks beside the number give the
chunk's state: approved or best effort, how many tokens, how many terms were
extracted. A "disputed" flag means translator and reviewer could not agree and a
human should look.

- **🔍 Find** — search and replace across the whole book, see below.
- **Hide the original** — when you are only working on the translation. The choice
  is remembered as you page through chunks.
- **A− 15 A+** — text size in both panes. Clicking the number restores the default.
- **Save** — write the edit.
- **Save and approve** — write it and mark the chunk approved.
- **Reset the chunk** — wipe this chunk's translation and history, to translate it
  from scratch.

What you type lives in the browser until you press Save. Reloading the page loses
it.

## What the review found here

If the translation review said anything about this chunk, its findings sit above
the text: the kind of error, the quote, what the problem is and what is advised.
"Show in the text" **selects the quote in the translation itself** — the cursor
lands on the words being objected to.

A quote that no longer occurs exactly once gets no button: the finding still
shows, but offering to jump somewhere ambiguous is worse than not offering.

## Search and replace across the book

**Ctrl+Shift+F**, or the 🔍 Find button. It searches **every chunk at once**, not
just the open one.

- In the translation, the original, or both.
- Whole words or any occurrence.
- Matching case or not.

Hits come back with their chunk number and the line they sit in. Clicking one
opens that chunk **with the match selected**, and the search survives the jump —
the list stays, with the current hit marked in it. A reload does not lose it
either: the whole search lives in the URL.

Ctrl+F is left to the browser: this page is longer than its text box.

### Replace

A "Replace with…" field and a "Replace all" button, plus a per-hit "replace" for a
single occurrence.

**Replace works on translations only.** The original is what everything else is
measured against — the review's quotes, chunk offsets, the fingerprint for
whole-book calls — and editing it would leave all of them describing a book that
no longer exists.

**A replace saves immediately**; it needs no Save. It touches chunks that are not
on screen, and either happens whole or not at all. If the translation box holds
unsaved edits you are warned first — replace works on the stored text.

**The undo is offered on the spot**, in the toast, and puts every touched chunk
back at once. Fifteen seconds; after that, undo it from the History screen.

An empty replacement deletes what was found. That is a legitimate operation, but it
has to be allowed by ticking "allow an empty replacement". The tick clears when the
panel closes: it is permission for the thing being done now.

## The edit history

At the bottom, every step this chunk went through, newest first. Opening one shows
the text as it then stood and, when the step has something to say, **why it
happened**:

- **fixed on the review** — the advice it was given;
- **replace** — which words became which, and how many times;
- **undo** — what it undid;
- **check** — the score, the verdict and the error count, plus the reviewer's
  comment.

Checks do not change the text; they judge it.

## What next

Changes across the whole book read better on the **History** screen, and the
review's findings are worked through on the **Monitor**.
