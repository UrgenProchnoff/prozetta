# Glossary: what the book calls its things

A book is translated in chunks, and the model sees each chunk on its own. Without
a shared list of names, a character called *Wei Ying* drifts into *Weiying* and
*Young Master Wei* a hundred pages later. The glossary is that shared list:
names, places, organisations, terms, and how each is to be translated.

The Extraction stage builds it, but it is a **draft**. Read it through before
translating: one correction here is cheaper than a hundred in the finished text.

## How the glossary reaches the translation

Everything else on this page follows from one fact: the model translating a
chunk **does not see the whole glossary**. Before each chunk the program looks
for glossary entries in its text and hands the translator only the ones it
finds — a short cheat sheet, one line per entry:

```
Maria Johnson -> Мария Джонсон (жен) — Верховный лидер Las Águilas Rojas (титул Феникс)
Phoenix -> Феникс — титул
```

The line holds the original, the translation, the gender (names only) and the
start of the note. It follows that:

- **An entry is found by its original, as a whole word, exactly.** The entry
  "Maria Johnson" does not fire in a chunk that says only "Johnson", and
  "Flourisher" does not fire where the text says "Flourishers". Every spelling the
  book uses needs an entry of its own.
- **A name is matched with its case, everything else without.** A character
  called Face, typed as a name, does not fire on every "face". A name gets two
  allowances: a leading article in either case ("the Advocate" for the entry "The
  Advocate"), and the whole name in capitals ("FACE").
- **The note is a dossier for the translator.** It arrives with the name in every
  chunk the name appears in, so it should answer "who is this": role, relations,
  key facts. The translator gets the first **120 characters**; the rest is cut.
- **Editing the glossary does not change text already translated.** It applies to
  the chunks translated after it.

## The table

- **Original** — as written in the book. This is what the entry is found by.
- **Translation** — how it should read in the target language.
- **Type** — `name` (a person or a being) or `term` (everything else). The type
  decides whether case matters in matching and whether gender is passed on.
- **Gender** — masculine, feminine, neuter. For Russian this matters: agreement
  around a name depends on it ("Элейн сказала", not "сказал").
- **Notes** — the entry's dossier, see above. A clone has a `= …` link here —
  see below.
- **#** — how many chunks the entry is found in. Zero means the book never uses
  that spelling: the entry is invented or written in the wrong form.
- **✕** — delete the row.

Edits are not saved on their own — press "Save". Until then, any edit can be
undone by simply leaving the page.

## The toolbar

- **Search** — across original, translation and notes at once.
- **+ Term** — add a row by hand.
- **Counter** — how many rows are shown out of how many.
- **Filter** — show one group of rows rather than all. Options appear only when
  they have something in them: "model review", "errors", "forms of one word",
  "people: forms of names", "untranslated". Each is described below.
- **Order** — as in the file, by original or by translation. It changes the view
  only: the file is saved in its own order.

## One person under several names: prime and clones

### The problem

A book calls one person several things: "Maria Johnson", "Johnson", "Ms
Johnson". Extraction files each spelling as a separate entry, and each gets its
own dossier — from whichever chunk it was found in:

```
Maria Johnson   Мария Джонсон   f   Supreme leader of Las Águilas Rojas (title: Phoenix)
Johnson         Джонсон         m   a participant in events
Ms Johnson      г-жа Джонсон    f   Maria Johnson — secret leader of Las Águilas Rojas
```

Deleting the extra ones is not an option: in a chunk that says only "Johnson",
only the entry "Johnson" fires — delete it and the translator never learns who
this is. But leaving them as they are is bad too: in that chunk the translator
gets the thin dossier "a participant in events" and the masculine gender.

### The solution

One entry is made the **prime** — it "speaks for the person". The others become
its **clones**. A clone stays in the table and is still found in the text by its
own spelling, but **takes its gender and dossier from the prime**. Only the
translation is the clone's own: "Ms Johnson → г-жа Джонсон" still shows how to
render the form of address.

What makes an entry a clone is its note: an `=` sign and the prime's name, and
nothing else:

```
Maria Johnson   Мария Джонсон   f   Supreme leader of Las Águilas Rojas (title: Phoenix)
Johnson         Джонсон             = Maria Johnson
Ms Johnson      г-жа Джонсон        = Maria Johnson
```

### What changes for the translator

A chunk that says only "Johnson":

```
before:  Johnson -> Джонсон (муж) — a participant in events
after:   Johnson -> Джонсон (жен) — Supreme leader of Las Águilas Rojas (title: Phoenix)
```

A chunk where several forms appear — one line instead of three:

```
Maria Johnson / Johnson -> Мария Джонсон / Джонсон (жен) — Supreme leader…
```

### Rules of the link

- After `=` you may write the prime's original or its translation: "= Maria
  Johnson" and "= Мария Джонсон" work the same.
- Both entries must be of type `name`.
- There must be exactly one prime, and it must not be a clone itself: no chains.
- If any of these fails, the entry works as an ordinary one, and the "errors"
  filter marks the link as not working, and why.
- The clone's own gender and note are not used — they can stay empty.
- Renaming the prime in the table updates its clones' links by itself.
- To unlink a clone, erase the link from its note (or press "Unlink" on the
  card, see below).

### A surname several people share

If the book has Rex Redman and Candy Redman, **do not link** the entry "Redman"
to either: in one chunk it is him, in another her. If the surname's gender
differs from the gender of someone's full name, the program drops the gender
from the surname by itself — it goes to the translator without one, and the full
names keep theirs.

## The "people: forms of names" filter

You do not have to type links by hand: the program works out which names look
like forms of one person and shows them as **one card per person**.

### How forms are found

Forms of address (Mr, Mrs, Ms, Miss, Mister, Dr, Captain, Detective and the like)
and articles are set aside. A name is a form of another if **all its remaining
words are in that other name**:

- "Johnson" and "Ms Johnson" are forms of "Maria Johnson";
- "Ida Willie" and "Mrs. Ida Willie West" are forms of "Ida Willie West";
- "Captain Zephyr" is a form of "Zephyr" (the same words; the name without the
  title becomes the prime).

A form is offered to the fullest name that has all its words. If there are
several ("Redman" beside Rex Redman and Candy Redman, "Deborah" beside Deborah
One and Deborah Two), the form appears on each of their cards, but **unticked**
and marked "?": the program does not know who it is and does not guess.

What this does not see: nicknames and titles that share no word with the name
("the Phoenix" for Maria Johnson), different spellings of one name ("Anna di
Malta" and "Anna de Malta"), entries of type `term`. Those are linked by hand, by
writing the link in the note.

Shared words do not guarantee one person: "Delia" may not be the same as "Real
Delia". So a card is only a proposal. Nothing changes until you press "Apply".

### Working with a card

1. **"prime" column** — pick the entry that will speak for the person. The
   fullest name is picked by default.
2. **"clone" column** — tick the forms that belong to this person. Untick those
   that do not.
3. **Notes** — use the round button to pick the best existing dossier; it goes
   into the "Shared note" field. The field can be edited by hand. The counter to
   its right shows the length — the translator gets at most 120 characters. "Join
   notes" strings together the notes of all ticked forms with ";" — quick and
   free, but usually long. "Combine with LLM" asks the main model to condense
   them into one dossier; only names and notes are sent, not the book.
4. **Gender** — one for the whole group. A ⚠ on a form means its gender or
   translation differs from the prime's: check it.
5. **"Apply"** — the prime gets the shared note and gender, the clones get `= …`
   links.
6. **"Save"** at the top of the page — write the glossary to disk.

"Unlink" removes all the group's links. Forms already linked appear on the card
too, so a group can be rebuilt at any time.

## The "forms of one word" filter

This filter is about terms, not people. Extraction files "replenisher" and
"replenishers" as two different terms and translates them separately:
«восполнитель» and «восстановители». The book comes out calling one thing by two
words.

Two entries are forms of one word if, with a leading article set aside, one is
the start of the other and what is left over is short (up to three letters) with
no space: "replenisher"/"replenishers", "cyte"/"cytes"/"cytes'",
"exchange"/"the exchange". "Swapper" and "Swapper movement" are not forms: the
leftover is a whole word.

A group is shown **only if its translations differ** — even by a capital letter.
The groups with the least similar translations come first; a difference in
capitals alone («обмен»/«Обмен») is also ranked high — it is almost certainly an
error. What to do with a group is your call: usually, make the translations
agree. Do not delete the entries themselves: each spelling is needed to be found
in the text.

## The "errors" filter

Only what can be checked against the book and the glossary itself:

- **Absent from the book** — zero matches. The entry is invented or written in
  the wrong form. Correct the original or delete the entry.
- **Case duplicate** — "ELAINE" and "Elaine". Keep one.
- **One name translated two ways** — "Ida Willie West → Ида Уилли Уэст" but "Ida
  Willie → Айда Уилли". Make them agree. For clones the check is stricter: if a
  clone and its prime share a word in the original, they must share a word in the
  translation too («Редмен» beside «Рекс Редман» is marked).
- **A "= …" link that does not work** — with the reason: no such entry, several
  of them, the target is a clone, the entry has the wrong type.

Gender is not in it. The program can guess gender from the pronouns in the
text, but it is wrong more often than it helps: a pronoun next to a name often
belongs to someone else.

The "untranslated" filter is separate: entries left in Latin script. That is not
a mistake but a transliteration decision — though it is worth checking that the
decision is the same for similar terms.

## The glossary review by the model

The "Ask the model" button on the card of the same name sends the model **the
whole book and the whole glossary** in one request. The model looks for what can
only be seen with everything at once: wrong dossiers, one person in several
entries, missing names, wrong translations and genders.

- Above the findings: which review this is, and the model's score from 1 to 10
  with its reason. It is one call's opinion, not a precise measure.
- Every finding carries a **quotation from the book**, and the program checks
  that the quotation is really there. Findings it cannot confirm are discarded.
- **Nothing is applied on its own.** Each finding has its own buttons: accept the
  correction, delete the entry, "Hide". The line at the top says how many are
  left. A new review can be asked for once the old findings are dealt with.

A **"link"** finding means the model thinks the entry is a form of another
entry's name ("Captain Zephyr" is "Zephyr"). Instead of a merge, which would
delete a spelling the book needs, it proposes making the entry a clone:

- "Link" sets the link at once. If the prime has no note or gender, it takes the
  clone's; if both have notes, the program first shows that the clone's note will
  be replaced.
- "Duplicates" opens that person's card under the finding — the same card as in
  the "people" filter: there you can choose the prime, the note and the gender
  for all forms at once.

A **"duplicate"** finding remains for real repeats — one spelling twice, with and
without an article ("The Scavenger" and "Scavenger"). A merge that would leave
part of the text without an entry is discarded by the program itself.

If the book and glossary do not fit the API quota, the button goes grey and
**"Build the prompt"** lights up: it prepares the text for a web console (Google
AI Studio, for instance), where the limits are larger. The answer is pasted back
and goes through the same checks.

## Deleting

The ✕ on the right deletes a row at once, without asking — but only on screen:
until "Save", leaving the page brings it back. Before deleting, consider whether
the entry is needed to be found in the text: a form of a name is better made a
clone than deleted.

## What next

Glossary read through — go back to the monitor and run the passport, then the
translation. If the book is already translated, editing the glossary will not
affect the finished text: that is corrected in the chunk editor or by
translating again.
