# Glossary: what the book calls its things

The glossary is an agreement about names. Every chunk is translated on its own,
and without such an agreement a character called *Wei Ying* drifts into *Weiying*
and *Young Master Wei* a hundred pages later. The glossary is what stops that.

It is collected during Extraction, but it is a **draft**, not a finished answer.
Reading it through before translating is worth it: one correction here is cheaper
than a hundred afterwards.

## The table

Each row is a term:

- **Original** — how the book writes it.
- **Translation** — how it should read. This is the field you edit.
- **Type** — name, place, thing, concept. It changes how the term is put in front
  of the translator, and where it is found: a name is matched **with its case**,
  anything else without. A character called Face does not fire on every "face"
  as long as the entry's type is a name. Two allowances for a name: a leading
  article may be in either case ("the Advocate" for an entry "The Advocate"), and
  the name written entirely in capitals is found too ("FACE").
- **Gender** — masculine, feminine, neuter. In an inflected target language this
  is not a detail: everything agreeing with the word depends on it.
- **Notes** — what the model learned about the term from the book. Often more use
  than the translation itself: "a street in East San Jose", "an estate agency;
  Susan Poker and Gretchen Bell work there".
- **#** — how many chunks the term occurs in. A term with zero occurrences was
  either invented or recorded in a form the text does not use.

Edits are not saved on their own — press Save.

## The toolbar

- **Search** — over originals, translations and notes at once.
- **+ Term** — add a row by hand.
- **513 / 513** — how many are shown out of how many.
- **0 occurrences — junk?** — a quick filter for terms the text does not contain.
- **Filter** — all entries, only those occurring, only edited ones, and so on.
- **Order** — as in the file, alphabetical, by frequency.

## The glossary review

One call for the whole book: the model reads the entire text and the entire list
and says what is wrong with it. The button is in its own "Ask the model" card.

Above the findings: which review this is and the model's grade — a score for the
glossary from 1 to 10 and its reason in a sentence or two. It is one call's
opinion, not a measurement: compare the scores of different reviews with care.

Findings are not applied on their own. You decide each one: accept the correction,
dismiss the finding, or mark that you dealt with it by hand. The bar at the top
says how many are left to work through.

Beside the button there is always a **second route** — "Build prompt". It prepares
text for a web console (Google AI Studio, for instance) where the window is bigger
and no API key is needed. The answer is pasted back and goes through exactly the
same checks. If the call does not fit the API quota, "Ask the model" goes dark and
"Build prompt" lights up — "too big" is a dead end only when the other door cannot
be seen.

## Forms of one word

The program separately shows groups where the same source term is recorded in
different forms: `replenisher` and `replenishers`, `exchange` and `the exchange`.
This is the commonest source of disagreement: stage 1 files them as two
independent terms and has no way to know they are one word — and the book comes
out saying it both ways.

The groups **do not decide for you**: they are ordered with the widest
disagreement first, and a person looks. A difference of case only is ranked high:
it is the one kind of disagreement that is certainly an error rather than
morphology.

## One person under several names

A book calls one person several things: "Maria Johnson", "Johnson", "Ms
Johnson". All three entries are needed, since each is found in the text by its
own spelling, and "Ms Johnson → г-жа Джонсон" also shows how to render the form
of address. What is not needed is three different descriptions of one person,
with the thinnest one on the surname.

So one entry can be made the **prime** and the others its **clones**. A clone's
note holds only the link:

    Johnson    Джонсон    note: = Maria Johnson

After `=` comes the prime's original or its translation ("= Мария Джонсон"
works too). A clone keeps its own translation and takes its gender and note from
the prime. In a chunk where several forms appear, the translator gets one line:

    Maria Johnson / Johnson -> Мария Джонсон / Джонсон (жен) — Верховный лидер…

The link takes effect only if both entries are of type "name", exactly one prime
matches, and the prime is not a clone itself. Otherwise the entry works as an
ordinary one. Do not link a surname several people share (Rex and Candy
Redman) to any of them.

A link can be typed by hand, or picked from the **"could be linked"** filter:
it lists names that, without forms of address (Ms, Dr and so on), are one word,
and that word appears in exactly one fuller name. "Johnson" and "Ms Johnson"
will be offered to "Maria Johnson"; "Redman", beside two Redmans, will not. The
Link button replaces the note with the link, and if there was a note it shows it
first so anything important can be moved to the prime. Renaming the prime
updates its clones' links by itself.

The source-text check watches the links: it marks a link that did not take
effect, and a clone translated differently from its prime. If the two share a
word in the original, "Johnson" and "Maria Johnson", they must share a word in
the translation, so «Редмен» beside «Рекс Редман» is marked. The glossary review
no longer proposes merging linked entries: the link has already done what the
merge was for.

## Deleting, and losing nothing by it

The cross on the right removes a row. But if the term being deleted occurs where
the survivor does not — `cytes` standing in 72 chunks that contain no `cyte` — you
are warned: the merge would lose coverage. A term with an article is safe to
delete; words are separated by spaces.

## What next

Once the glossary reads right, go back to the monitor, build the passport and run
the translation. Editing the glossary **does not change already translated text**:
if the book is translated, changing it means search and replace in the chunk
editor.
