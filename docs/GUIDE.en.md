# prozetta for beginners: from installing it to a finished book

This walkthrough is for people who do not run programs "from the command line".
No special knowledge is needed: download it, start it with a double click, paste a
key, load a book — and the translation is running.

**What you will need:**

- a computer with Windows, macOS or Linux, and an internet connection;
- a Google account, for a free key to the Gemini model;
- a book as a plain `.txt` file;
- 15–20 minutes to install. Translating the book itself takes anywhere from an
  hour to a day, depending on its size and on the free tier's limits.

Steps 1–7 get you a finished text; steps 8–10 get you a book worth opening in a
reader app. At the end: how to update, and what to do when something goes wrong.

---

## Step 1. Install Node.js

Node.js is what prozetta runs on. It is installed once, like any other program.

1. Open [nodejs.org](https://nodejs.org/) and download the **LTS** version (the
   button in the middle).
2. Run the installer and accept the defaults all the way through
   ("Next → Next → Install").

On Linux you can use your repository instead: `sudo apt install nodejs npm`
(Ubuntu/Debian) or `sudo dnf install nodejs` (Fedora).

You do not have to verify the installation: if something went wrong, prozetta will
say "Node.js not found" at the next step.

## Step 2. Download prozetta

1. Open the project page: <https://github.com/UrgenProchnoff/prozetta>
2. Press the green **Code → Download ZIP** button.
3. Unpack the archive somewhere convenient, `Documents` for instance — you get a
   `prozetta-main` folder.

If you have git, this does the same: `git clone https://github.com/UrgenProchnoff/prozetta.git`

## Step 3. Start the program

**Windows:** open the program's folder and double-click **`start.bat`**. If Windows
shows a "Windows protected your PC" warning, press "More info" → "Run anyway".

**macOS / Linux:** open the program's folder in a terminal and run:

```bash
./start.sh
```

What happens:

1. On the **first** run the script spends a couple of minutes installing
   dependencies — let it finish.
2. The server starts, and a few seconds later your browser opens
   `http://127.0.0.1:3457` by itself. If it does not, type that address in.

> **Important:** the black window (the terminal) *is* the running program. While a
> translation is going, do not close it. The browser tab can be closed at any
> moment — the translation carries on, and the tab can always be opened again.

To shut the program down, close the terminal window (or press `Ctrl+C` in it).

## Step 4. Get a free Google key

The translating is done by Google's Gemini. For prozetta to reach it you need an
API key — a long password-like string. Google has a free tier, and it is enough
for translating books (with a speed limit).

1. Open [aistudio.google.com](https://aistudio.google.com/) and sign in to your
   Google account.
2. Press **Get API key**, then **Create API key**.
3. Copy the string that appears (it starts with `AIza…`) — that is the key.

> A key is like a password: do not publish it and do not send it to anyone.
> prozetta keeps it on your computer only, in `src_v4/config.overrides.json`.

## Step 5. Paste the key into the settings

1. In the prozetta interface that opened, go to **Settings** (top of the page).
2. In **Active model**, choose **Google**.
3. In the **Google** group find the key field (its placeholder reads "new key
   (empty — keep)") and paste the key you copied.
4. Press **Save**.
5. Press **Test** beside the Google group. If everything is right you get a green
   tick with a response time ("✓ 800 ms"). If it says "✗ error", see "Common
   problems" below.

> **Which model to choose.** The model is named in the **Google** group, in the
> `modelName` field. On the free tier we recommend **`gemma-4-31b-it`** or
> **`gemma-4-26b-a4b-it`**: Google allows up to **1500 requests a day** on those,
> noticeably more generous than on the Gemini models. One chunk of a book costs
> several requests (a translation plus a check), so a day's allowance covers a
> solid part of a book; the next day the translation carries on from where it
> stopped.
>
> One catch: Gemma models have a built-in content filter that cannot be switched
> off. If the book has rough scenes, some chunks may refuse to translate — switch
> to a Gemini model for a while then (see "Common problems").

## Step 6. Load the book and start translating

### Prepare the file

The book has to be a plain `.txt` file:

- from **Word**: "File → Save As → Plain Text (*.txt)";
- from **FB2 / EPUB**: convert it, with the free [Calibre](https://calibre-ebook.com/)
  for instance;
- you do not have to check the encoding — prozetta recognises and repairs it
  itself.

### Load it and translate

1. On the front page (**Projects**) press **"📥 Upload a book (.txt)"** and choose
   the file. The book's **Monitor** page opens.
2. Set the **target language** and the file suffix (language `English`, suffix
   `en`, say — the result will be named `Book_en.txt`). The language is set once,
   on the first run.
3. Pick a step on the roadmap and press the start button — it names the step it
   will run: **▶ Start: Translation**. There are two routes:

**Just translate it (the quick route).** Pick **Translation** on the roadmap and
start. The program will warn you that there is no glossary — confirm. The book
will be split into chunks and translated straight away. Good for short texts and
for a first look.

**The careful route (recommended for books).** Run **Extraction** first: the
program reads the whole book and gathers a **glossary** — the names and terms with
their translations. When the step finishes, open the **Glossary** section, read it
through and correct the names (this is the most valuable thing you can do by hand;
it is what makes names the same from beginning to end). Then run **Translation**.

There are two optional steps on the roadmap between them, and both are worth the
time. **Glossary review** — the model reads the whole book and says what is wrong
with the list; every finding is yours to accept or dismiss. **Passport** — the
decisions made once for a whole book: what person the narration is in, what tense,
the form of address, who the cast are and what gender. Without a passport every
chunk decides these again, and decides differently.

If you do not know what to press, read the line under the roadmap: it names the
next step, and the start button is already aimed at it.

While the translation runs, the Monitor shows a live log and a map of the book's
chunks: green ones are translated, grey ones are queued. Any chunk can be opened
and edited by hand.

> A translation can be interrupted — with the "■ Stop" button or by closing the
> terminal. The next time Translation runs it picks up where it stopped: finished
> chunks are not translated again.

## Step 7. Collect the result

When every chunk is translated, press **"⬇ Translation"** on the Monitor — a
`<book>_<suffix>.txt` file downloads. The same file sits in the `txt/` folder
inside the program's own folder.

That is already a readable translation, and you can stop here. The next three
steps are about making it noticeably better and turning it into a book.

## Step 8. Check the translation as a whole

The translating went chunk by chunk, and that has a blind spot: from inside one
chunk you cannot see that a term in chapter seven came out differently from
chapter three, that a joke went missing, or that the register slipped into
officialese in one place. So there is a step of its own — **Translation review**:
one call in which the model reads the finished text whole.

Pick **Translation review** on the roadmap and press start. When it finishes, a
"Translation review" section appears under the map: a score and a list of
findings.

> **If the call does not fit.** A request like this is the entire book at once,
> and on a free tier it may not go through: what blocks it is not the size of the
> model's window but the quota on input tokens per minute. The program says so
> with a number and opens the "Run by hand" box for you. Press "Build prompt",
> copy the text, paste it into a web console — [AI Studio](https://aistudio.google.com/),
> for instance, where the window is a million tokens and no key is needed — then
> paste the model's whole reply back into the same box and press "Take the
> answer". It goes through exactly the same checks as an answer from the API. The
> "with the original" tick sends the source text along too: twice the tokens, and
> it finds errors of meaning that the translation alone cannot show. If an answer
> is refused, the reason stays under the box, with the line, the column and the
> line itself.

## Step 9. Work through the findings and run Translation again

Every finding is **a decision, not a notification**. Nothing applies itself.

- **Accept** — the advice is queued on its chunk.
- **Dismiss** — the finding is wrong. Changed your mind? At the end of the list
  there is a folded "Dismissed findings" block, each with a **Take back** button.
- **Done** — you have already fixed it yourself, by hand.
- The button with the chunk number opens that chunk on the quote itself.

Once you are through them, run **Translation** again. The line under the roadmap
will say so itself: "Advice queued from the review: 7. Run Translation — it fixes
only the marked chunks." And so it does: the book is not translated again. Only
the chunks carrying advice are touched, and not by translating them from scratch
but by correcting the existing text along that advice; the run then checks the
result, exactly as an ordinary translation does.

A finding leaves the list by itself once the text it complained about is gone. If
you want another round, run "Translation review" again: it reads the corrected
text.

## Step 10. Build the book as FB2

The **"📖 Book (FB2)"** link at the top of the Monitor opens the assembly page:

- **Title** and **Author** — what a reader app shows on its shelf. An empty title
  falls back to the project name, but a real one is better: the project name
  usually comes from a filename.
- **Annotation** — what the book is about; the reader app shows it in the
  description. Every line becomes its own paragraph.
- **Cover** — JPEG or PNG up to 10 MB, optional.

The **"⬇ Download FB2"** button assembles the book. Chapters are found
automatically from headings in the text — "Chapter 7", "Prologue", short lines in
caps, numbers standing alone — and "* * *" separators become scene breaks. Beside
it is a button for plain text, if FB2 is not what you want.

---

## How to update

A new version comes as the same archive. What is new in it can be seen inside the
program: the version number at the bottom of any page leads to the changelog.

1. Download the fresh ZIP (Step 2) and unpack it **over** the program's folder,
   agreeing to replace the files.
2. Start `start.bat` / `start.sh` as usual.

Nothing of yours is in the archive, so replacing files can lose nothing: project
state and translations live in `projects/`, finished files in `txt/`, and the key
and settings in `src_v4/config.overrides.json`. Neither those folders nor that
file exist in the archive at all.

> Beware of archivers that offer to **empty** the destination folder before
> unpacking. Do not let them: your projects would leave along with the old
> version. What you want is "replace existing files".

If the program will not start after an update, or complains about modules, delete
the `node_modules` folder inside it and start again: the dependencies install
afresh — the same couple of minutes as on the first run.

---

## Common problems

**The browser did not open by itself.** Type `http://127.0.0.1:3457` into the
address bar. Check that the terminal window is open and has no errors in it.

**"Node.js not found".** Go back to Step 1. After installing Node.js, run
`start.bat` / `start.sh` again.

**The key test says "✗ error".** Check that the key was copied whole, with no
spaces at either end. Make sure you pressed Save after pasting it. In some
countries Google AI is not reachable directly and you will need a VPN.

**The translation runs but often reports errors or stalls for a long time.** Most
likely you have run into the free tier's limits (so many requests per minute and
per day). This is not a disaster: the program retries failed requests itself. If
it is the daily limit, stop the translation and run Translation tomorrow — it
carries on from the same place. You can also lower the request rate (Settings →
the Google group → `maxRPM`, 5 for instance) or switch to a model with a more
generous daily allowance — `gemma-4-31b-it` or `gemma-4-26b-a4b-it` (up to 1500
requests a day, see Step 5).

**"Google API returned an empty response (0 candidates)" in the log.** Google's
content filter refused that particular chunk (violence, explicit scenes and so on
— even in fiction); the exact reason is printed beside it in the log
(`promptFeedback` / `finishReason`). During Extraction this is not a problem:
prozetta skips the chunk and carries on, and the chunk gets a red mark in the
top-left corner of its cell on the map — its terms simply do not reach the
glossary.

To get the terms out of the refused chunks anyway: change the model or the
provider in Settings (from Gemma to Gemini, for instance — Gemma's filter is
built in and cannot be switched off, while for Gemini prozetta switches off
everything that can be) and run Extraction again. **Only** the refused chunks are
repeated, the terms found are merged into the glossary, and your own edits in it
are not touched. You can switch the model back afterwards.

If the refusal gets in the way during Translation and changing the model did not
help (Google allows nobody to switch off certain categories), translate the chunk
by hand on its own page and run Translation again: finished chunks are not
recomputed.

**The file will not upload.** Only `.txt` files are accepted. If it is a Word
document or FB2/EPUB, save or convert it to plain text first (see Step 6).

**A book or project with this name already exists.** Rename the book's file, or
delete the old project on the front page (the "🗑 Delete" button).

**127.0.0.1:3457 is taken by another program.** Start on a different port: in a
terminal `GUI_PORT=3500 ./start.sh` (Windows: `set GUI_PORT=3500` before running
`start.bat`), then open `http://127.0.0.1:3500`.

**You want a better model, or a different provider.** In Settings you can pick any
OpenAI-compatible service (the "Custom" group) or a local model — those are
subjects for the main [README](../README.md).
