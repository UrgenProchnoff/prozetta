import fs from 'fs';
import util from 'util';
import { projectPaths, ensureProjectDir } from '../core/paths.js';

// Matches ANSI color/style escape sequences so the file stays plain text.
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/**
 * Tee all console output of this process into the project's own log file
 * (`projects/<book>/run.log`, beside its state).
 * Appends across runs; each run starts with a separator header.
 * Writes are synchronous so nothing is lost on process.exit() or a crash.
 */
export function initFileLog(workDir, filePrefix) {
    const logFile = projectPaths(workDir, filePrefix).log;

    let fd;
    try {
        // A run can start before the project has written anything of its own.
        ensureProjectDir(workDir, filePrefix);
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
