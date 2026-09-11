# The monitor: a book's main screen

The monitor is one book, whole: what state it is in, what to do with it next, and
what the program is doing this minute. Everything that runs a translation lives
here; the other pages — glossary, passport, history, a single chunk — open from
here and lead back.

The screen reads top to bottom, and the order is not arbitrary. At the top, where
the book stands. In the middle, what it has become. On the right, what is
happening right now.

## The pipeline: seven steps, and where you are on them

The row of circles at the top is the whole path from a file to a finished
translation. A circle is solid when the step is done, dotted when it is not, and
filled while it is running.

**Extraction** reads the book chunk by chunk and pulls out names, titles and
terms — everything that has to read the same way from beginning to end. The line
under it counts chunks: `129/129`.

**Glossary** is what was extracted, gathered into one list: `513 terms`. Not a
finished answer but a draft worth reading through. The Glossary link at the top
right opens it.

**Glossary review** is one call for the whole book: the model reads the entire
text and the entire list and says what is wrong with it. The line counts what it
found: `59 findings`. Nothing is applied on its own.

**Passport** holds the decisions that are made once for a whole book and cannot
be made inside a single chunk: what person the narration is in, what tense, the
form of address, who the cast are and what gender, how direct speech is set. Its
line reads `first person, 1 character`. Without a passport every chunk decides
these again — and decides differently.

**Translation** is the work itself: chunk by chunk, each checked and corrected
after drafting. Its line: `129/129`.

**Translation review** is another whole-book call, this time over the finished
text. It finds what cannot be seen from inside one chunk: a broken register,
terms that disagree, a joke that went missing. Its line: `10 findings, score 7`.

**Export** puts the chunks back together into a book. Its line says `built` or
`stale` — stale meaning the text was edited after the file was assembled, so what
is on disk is no longer what is in the project.

The step with a **star** is the one the program suggests doing next. Dotted steps
that can be skipped say so on hover: "optional — it improves the translation, but
the book will translate without it".

## The recommendation line and Start

Under the pipeline sits one sentence about what to do next, and the button that
does it. The sentence follows the state of the book:

- "Project not created. Start with Extraction — it pulls the names and terms out of the book."
- "Terms extracted, but the glossary is empty. Check or fill in the glossary
  before translating."
- "Advice queued from the review: 7. Run Translation — it fixes only the marked
  chunks."
- "Every chunk is translated. You can assemble the book (export) or open a chunk
  to edit by hand."

The button names its step: **"▶ Start: Translation"**. Until you pick a step on
the roadmap yourself it is aimed wherever the recommendation points, and it moves
when the recommendation does. Click a circle and the button follows you from then
on, the recommendation staying as the sentence in the line.

Stop halts a run. Everything already translated stays: the next run picks the
book up at the chunk it was abandoned on.

## The chunk map

The grid of numbered cells is the whole book. One cell is one chunk of text,
around four thousand characters. **Every cell is clickable**: it opens a page with
the original, the editable translation, and that chunk's history.

The colour says what became of the chunk:

- **green** — approved: the translation passed its check;
- **yellow** — best effort: never approved, the best of the attempts kept;
- **blue** — in progress right now;
- **red** — refused by the content filter;
- **grey** — queued, not translated yet.

The corners are marks that are not about colour:

- **red corner** — the content filter refused this text during Extraction, so its
  terms never reached the glossary;
- **violet corner** — the chunk was fixed on the review's advice, or is waiting to
  be;
- **flag** — translator and reviewer could not agree; a human should look.

The number under the index is the checker's score, and it **shows only when it is
below ten**. An empty cell means ten. A marker should mark the exception, not the
rule: a map of 129 tens would say nothing at all.

## Translation review

A folded section under the map. Its heading carries the verdict: `score 7/10 · 10
open, 35 closed by editing, 14 rejected · 7 queued`.

Inside is the list of findings. Each one is **a decision, not a notification**:

- **Accept** — the advice is queued on that chunk, and the next Translation run
  fixes it. The chunk gets a violet corner.
- **Dismiss** — the finding is wrong; hide it.
- **Done** — you dealt with it yourself, by hand.

The button with the chunk number opens that chunk **on the quote itself**, which
arrives selected in the editable text.

A dismissal is not a deletion: at the end of the list is a folded **Dismissed
findings** block, each with a **Take back** button that returns it to the open
ones. Dismissing is a judgement, and a judgement can be hasty — the more so when
there are sixty findings to make it about.

A finding leaves the list on its own once the text it complained about is gone.
Nothing is applied without you.

## Run by hand

The second route for whole-book calls — the glossary review, the passport, the
translation review. What blocks the API route is not the size of the model's
window but the **quota on input tokens per minute**: on a free tier it runs out
long before the window does.

Build prompt prepares text you can paste into a web console — Google AI Studio,
for instance, where the window is a million tokens and no API key is needed. The
answer is pasted back into the same box and goes through **exactly the same
checks** as an API answer: every finding must carry a verbatim quote, and the
quote must be findable in the text.

The manual route can also do something the API one cannot: only through it can the
**original** be sent alongside the translation. That is twice the tokens — and it
finds errors of meaning that the translation alone cannot show.

## Token spend

What this run cost and what the project has cost in total, broken down by kind of
call. Useful when you are paying per token, or running into a quota.

## The log on the right

The program's live output — the same thing the terminal shows, without having to
find the terminal. A separator is written between runs, so it is clear where the
last one ended and this one began. The history survives restarting the program.

## The links at the top right

- **Glossary** — the editable term list, and the glossary review with it.
- **Passport** — the whole-book decisions, editable by hand.
- **History** — everything that changed the translation, with time, chunk and kind
  of change, showing the change itself and offering an undo.
- **Translation** — download the finished text.
- **Book (FB2)** — assemble a book with a cover and a table of contents.

## What to do in the usual cases

**The translation is done; what now.** Run the translation review — it reads the
book whole and sees what per-chunk work cannot. Work through the findings, run
Translation again (it fixes only the marked chunks), then Export.

**A chunk is red — refused by the filter.** The model declined this text and will
decline it again. Change model or provider in Settings and run the stage again:
only the refused chunks are picked up, nothing else is touched. A local model has
no such filter.

**A call does not fit the quota.** The program says so with a number: "does not
fit the model's limit: 195,000 tokens against a limit of 170,000." Open Run by
hand and carry the prompt to a web console.

**One word needs changing across the whole book.** Open any chunk and press
Ctrl+Shift+F. The search covers every chunk at once, in the translation or in the
original; replace works on translations only, and one undo takes it all back.

**Something went wrong.** Open History: everything that changed the text is there,
newest first, showing the change and offering to undo it. An undo is recorded
rather than erased — so it can be undone in its turn.
