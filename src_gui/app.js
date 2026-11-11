/**
 * The express application and the fixed places it works from.
 *
 * A module of its own so that every group of routes can register itself on the
 * same app: server.js imports the groups, and each group imports this.
 */
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const TXT_DIR = path.join(ROOT, 'txt');
export const CONFIG_PATH = path.join(ROOT, 'src_v4', 'config.js');
export const OVERRIDES_PATH = path.join(ROOT, 'src_v4', 'config.overrides.json');
export const PRESETS_PATH = path.join(ROOT, 'src_v4', 'config.presets.json');
export const UPDATE_CACHE_PATH = path.join(ROOT, '.update-check.json');
export const PORT = process.env.GUI_PORT || 3457;

export const app = express();

// Only this machine's own pages may talk to the server.
//
// Listening on 127.0.0.1 keeps other computers out, but not other websites: any
// page open in the same browser can send a request here. A POST that needs no
// body — /api/config/reset, which deletes the saved settings and every API key
// with them — goes through from a plain no-cors fetch, and the upload endpoints
// take any content type. Worse, a site that re-points its own domain at
// 127.0.0.1 (DNS rebinding) is same-origin with us as far as the browser can
// tell, and /api/config/test would then send the saved key to whatever address
// that site puts in the form.
//
// Both are told apart by headers the page cannot forge. Host names the address
// the browser thinks it is talking to, so a rebound domain carries its own name
// there; Origin names the page that made the request, and a browser sends it on
// every cross-site one. The interface itself is always 127.0.0.1 or localhost
// on this port.
const LOCAL_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
app.use((req, res, next) => {
    const host = String(req.headers.host || '').toLowerCase();
    const origin = req.headers.origin;
    const originOk = origin === undefined
        || [...LOCAL_HOSTS].some(h => String(origin).toLowerCase() === `http://${h}`);
    if (LOCAL_HOSTS.has(host) && originOk) return next();
    res.status(403).json({ error: 'Requests are accepted only from the prozetta interface on this machine.' });
});

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'web')));
