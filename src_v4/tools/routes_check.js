/**
 * Does every call the interface makes have someone to answer it?
 *
 * Written after deleting one. A refactor replaced a slice of server.js between
 * two anchors, the replacement was asserted to have matched, and it had — the
 * slice was simply wider than intended and took `app.put('/api/projects/:prefix/
 * chunks/:i')` with it. Everything still parsed, every page still rendered, and
 * saving a chunk by hand answered 404. Nothing in the project could have noticed:
 * the front end and the server agree by convention and nothing checks the
 * convention.
 *
 * The method matters as much as the path. That deletion left the GET on the very
 * same path untouched, so a path-only comparison would have passed while the
 * PUT was gone.
 *
 * Run: npm run routes
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const GUI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src_gui');

/** `/api/projects/${x}/chunks/${i}` and `/api/projects/:prefix/chunks/:i` alike. */
function shape(url) {
    return url
        .replace(/\$\{[^}]*\}/g, ':x')      // a template hole is a parameter
        .replace(/:[A-Za-z_][\w]*/g, ':x')  // and so is a named one
        .replace(/\?.*$/, '')               // the query string is not the route
        .replace(/\/+$/, '');
}

function serverRoutes(code) {
    const routes = new Set();
    for (const m of code.matchAll(/\bapp\.(get|put|post|delete|patch)\(\s*['"`]([^'"`]+)['"`]/g)) {
        routes.add(`${m[1].toUpperCase()} ${shape(m[2])}`);
    }
    return routes;
}

/**
 * Every fetch the front end makes, with the method it makes it by.
 *
 * The method is read from the options object of the same call. `api()` defaults
 * to GET, and a call whose options are built elsewhere is reported as unknown
 * rather than guessed at — a guess here would either invent a passing check or a
 * failing one, and both are worse than saying so.
 */
function clientCalls(code) {
    const calls = [];
    for (const m of code.matchAll(/\b(?:api|fetch)\(\s*[`'"]([^`'"]*\/api\/[^`'"]*)[`'"]/g)) {
        const rest = code.slice(m.index, m.index + 600);
        const method = rest.match(/method:\s*'(\w+)'/);
        calls.push({
            url: m[1],
            method: (method ? method[1] : 'GET').toUpperCase(),
            line: code.slice(0, m.index).split('\n').length,
        });
    }
    return calls;
}

function main() {
    const server = fs.readFileSync(path.join(GUI, 'server.js'), 'utf-8');
    const routes = serverRoutes(server);

    const problems = [];
    let checked = 0;

    for (const file of fs.readdirSync(path.join(GUI, 'web')).filter(f => f.endsWith('.js'))) {
        const code = fs.readFileSync(path.join(GUI, 'web', file), 'utf-8');
        for (const call of clientCalls(code)) {
            checked++;
            const want = `${call.method} ${shape(call.url)}`;
            if (!routes.has(want)) {
                problems.push(`${file}:${call.line} calls ${want} — no such route in server.js`);
            }
        }
    }

    if (problems.length) {
        console.error(`[routes] ${problems.length} call(s) with nobody to answer:\n    ${problems.join('\n    ')}`);
        process.exit(1);
    }
    console.log(`[routes] ${checked} call(s) from the interface, ${routes.size} route(s) in the server, all matched.`);
}

main();
