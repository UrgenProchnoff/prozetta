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
  of the translator.
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
