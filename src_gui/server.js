/**
 * prozetta GUI server — the entry point.
 *
 * The routes live in routes/, one file per part of the interface; importing a
 * file registers its routes on the app (see app.js).
 */
import { PORT, app } from './app.js';

import './routes/about.js';
import './routes/projects.js';
import './routes/chunks.js';
import './routes/passport.js';
import './routes/glossary.js';
import './routes/run.js';
import './routes/review.js';
import './routes/book.js';
import './routes/settings.js';

app.listen(PORT, '127.0.0.1', () => {
    console.log(`[GUI] prozetta GUI running at http://127.0.0.1:${PORT}`);
});
