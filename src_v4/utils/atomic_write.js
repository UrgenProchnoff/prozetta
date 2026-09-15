/**
 * Write a file whole or not at all: into `<file>.tmp` first, then renamed over
 * the real one, so a crash mid-write leaves the previous version intact rather
 * than half of a new one.
 *
 * The rename is retried when the operating system says the destination is
 * busy. Windows will not replace a file that another process holds open, and
 * something nearly always has just opened a file this program has just
 * written: Windows Defender scans it on close, a sync client (OneDrive,
 * Dropbox) picks it up, and the GUI server itself re-reads state.json the
 * moment it changes, to redraw the chunk map. Each lets go within moments.
 *
 * Found at the end of a translation, which saves the state twice a few
 * milliseconds apart: the second rename landed on a multi-megabyte state.json
 * still open from the first, and a finished run died with
 * "EPERM: operation not permitted, rename". Nothing was lost — the first save
 * had gone through — but a crash is a crash, and the same can hit any of the
 * files written this way.
 */
import fs from 'fs';
import path from 'path';

// The answers Windows gives for "someone has it open". On other systems the
// first two can be a real permission problem, which then fails after the same
// short wait instead of at once — a fair price for one code path everywhere.
const BUSY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

// About two seconds in all, the pauses growing: most holders let go within the
// first few tens of milliseconds, and a scan of a large file takes longer.
const RETRY_DELAYS_MS = [10, 20, 40, 80, 150, 250, 400, 500, 550];

/** Block this thread for `ms`. Saves are synchronous, so the wait has to be too. */
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Rename `from` over `to`, retrying while the destination is busy.
 *
 * @param {object} [io]  Stand-ins for `rename` and `sleep`, for testing the
 *   retries without a Windows machine to hold a file open.
 * @throws the last error, reworded to say what holds the file and where the
 *   new content went, when the destination stays busy through every retry.
 */
export function renameWithRetry(from, to, io = {}) {
    const rename = io.rename || fs.renameSync;
    const sleep = io.sleep || sleepSync;
    let waited = 0;

    for (let attempt = 0; ; attempt++) {
        try {
            rename(from, to);
            return;
        } catch (e) {
            if (!BUSY_CODES.has(e.code)) throw e;
            if (attempt >= RETRY_DELAYS_MS.length) {
                const err = new Error(
                    `Could not replace ${to}: ${e.code}. Another program kept the file open for ` +
                    `${waited} ms — usually an antivirus scan or a sync client such as OneDrive or Dropbox. ` +
                    `The complete new content is beside it in ${path.basename(from)}.`);
                err.code = e.code;
                err.cause = e;
                throw err;
            }
            sleep(RETRY_DELAYS_MS[attempt]);
            waited += RETRY_DELAYS_MS[attempt];
        }
    }
}

/** Write `data` to `file` atomically. */
export function writeFileAtomic(file, data, io = {}) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, data);
    renameWithRetry(tmp, file, io);
}
