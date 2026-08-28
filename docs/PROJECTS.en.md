# Projects: the list of books

The program's first screen. Every book you have ever loaded is here, and a new
one starts here.

## Loading a book

"📥 Upload a book (.txt)" takes a text file and puts it in the `txt/` folder
beside the program. The encoding is worked out for you — a file in windows-1251
or koi8-r is converted to UTF-8 and you are told that it was.

You can also drop files into `txt/` by hand. Those show up at the bottom of the
screen under "New books in txt/", marked as having no project yet. Clicking one
opens the monitor, where the first stage is waiting to be run.

The filename becomes the project name, so a short plain name saves trouble later.

## A book's card

Each book is a card carrying its own state:

- **Updated** — when the project was last touched.
- **Chunks** — how many pieces the text was cut into.
- **Glossary** — how many terms have been collected.
- **extracted: 40/129** — while the first stage is still working through.
- **⚡ running** — work is going on for this book right now.

A red mark with a count means chunks the content filter refused to translate.
Switch model or provider in Settings and rerun the stage — only those are picked
up.

## The card's buttons

- **Monitor** — the book's main screen, where everything is run from.
- **Glossary** and **Passport** — straight to them, skipping the monitor.
- **⬇ Translation** — download the finished text.
- **🌐 Translate into another language** — see below.
- **🗑 Delete** — removes the state, the glossary and the assembled translation.
  **The source text in `txt/` stays**, and so does a backup of the state
  (`.deleted.bak`).

## Translating into another language

"🌐 Translate into another language" makes a new project out of the book. The
point is that **the chunking and the extracted terms are reused** — the longest
and most expensive part of the work is already done and is not repeated. Only the
glossary and the translation are made afresh, because those belong to a language.

You are asked for the language and a short file suffix (`de`, `en`, `fr`), and the
new project's monitor opens.

## What next

Once a book is loaded the monitor opens, and all the work happens there: see the
**Monitor** article.
