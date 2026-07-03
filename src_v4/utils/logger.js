import fs from 'fs';
import path from 'path';
import util from 'util';

// Matches ANSI color/style escape sequences so the file stays plain text.
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/**
 * Tee all console output of this process into a per-project log file
 * (`<prefix>_run.log`, next to `<prefix>_project_state.json`).
 * Appends across runs; each run starts with a separator header.
 * Writes are synchronous so nothing is lost on process.exit() or a crash.
 */
export function initFileLog(workDir, filePrefix) {
    const prefix = filePrefix ? `${filePrefix}_` : '';
    const logFile = path.join(workDir, `${prefix}run.log`);

    let fd;
    try {
        fd = fs.openSync(logFile, 'a');
    } catch (e) {
        console.error(`[Log] Could not open log file ${logFile}: ${e.message}`);
        return null;
    }

    const write = (text) => {
        if (fd === null) return;
        try {
            fs.writeSync(fd, text);
        } catch {
            fd = null; // a broken log file must never crash the translation run
        }
    };

    const writeLine = (level, args) => {
        const text = util.format(...args).replace(ANSI_RE, '');
        const ts = new Date().toISOString();
        write(text.split('\n').map(line => `${ts} ${level} ${line}\n`).join(''));
    };

    for (const [method, level] of [['log', 'INFO'], ['info', 'INFO'], ['warn', 'WARN'], ['error', 'ERROR']]) {
        const original = console[method].bind(console);
        console[method] = (...args) => {
            original(...args);
            writeLine(level, args);
        };
    }

    write(`\n=== RUN ${new Date().toISOString()} :: node ${process.argv.slice(1).join(' ')} ===\n`);
    process.on('exit', (code) => write(`=== EXIT code=${code} ${new Date().toISOString()} ===\n`));

    return logFile;
}
