import { spawn } from 'child_process';

const LOG_LIMIT = 1000;

class JobManager {
    constructor() {
        this.jobs = new Map();      // prefix -> { proc, log, running, args, startedAt, exitCode }
        this.subs = new Map();      // prefix -> Set<res> (SSE clients)
    }

    isRunning(prefix) {
        const job = this.jobs.get(prefix);
        return !!(job && job.running);
    }

    getJob(prefix) {
        const job = this.jobs.get(prefix);
        if (!job) return { running: false, log: [] };
        return {
            running: job.running,
            args: job.args,
            startedAt: job.startedAt,
            exitCode: job.exitCode,
            log: job.log
        };
    }

    start(prefix, args, cwd) {
        if (this.isRunning(prefix)) {
            throw new Error(`Job already running for project "${prefix}"`);
        }

        const job = {
            proc: null,
            log: [],
            running: true,
            args,
            startedAt: new Date().toISOString(),
            exitCode: null
        };
        this.jobs.set(prefix, job);

        const proc = spawn(process.execPath, args, { cwd, env: process.env });
        job.proc = proc;

        const pushLines = (buf) => {
            for (const line of buf.split('\n')) {
                if (!line.trim()) continue;
                job.log.push(line);
                if (job.log.length > LOG_LIMIT) job.log.shift();
                this.broadcast(prefix, 'log', line);
            }
        };

        let stdoutRest = '';
        proc.stdout.on('data', (d) => {
            stdoutRest += d.toString();
            const i = stdoutRest.lastIndexOf('\n');
            if (i >= 0) {
                pushLines(stdoutRest.slice(0, i));
                stdoutRest = stdoutRest.slice(i + 1);
            }
        });

        let stderrRest = '';
        proc.stderr.on('data', (d) => {
            stderrRest += d.toString();
            const i = stderrRest.lastIndexOf('\n');
            if (i >= 0) {
                pushLines(stderrRest.slice(0, i));
                stderrRest = stderrRest.slice(i + 1);
            }
        });

        proc.on('close', (code) => {
            if (stdoutRest.trim()) pushLines(stdoutRest);
            if (stderrRest.trim()) pushLines(stderrRest);
            job.running = false;
            job.exitCode = code;
            this.broadcast(prefix, 'job', { running: false, exitCode: code });
        });

        proc.on('error', (err) => {
            job.log.push(`[GUI] Failed to spawn process: ${err.message}`);
            job.running = false;
            this.broadcast(prefix, 'job', { running: false, error: err.message });
        });

        this.broadcast(prefix, 'job', { running: true, args });
        return job;
    }

    stop(prefix) {
        const job = this.jobs.get(prefix);
        if (!job || !job.running) return false;
        job.proc.kill('SIGTERM');
        return true;
    }

    subscribe(prefix, res) {
        if (!this.subs.has(prefix)) this.subs.set(prefix, new Set());
        this.subs.get(prefix).add(res);
        return () => {
            const set = this.subs.get(prefix);
            if (set) {
                set.delete(res);
                if (set.size === 0) this.subs.delete(prefix);
            }
        };
    }

    broadcast(prefix, event, data) {
        const set = this.subs.get(prefix);
        if (!set) return;
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const res of set) {
            try { res.write(payload); } catch { /* client gone */ }
        }
    }
}

export const jobManager = new JobManager();
