/**
 * Run the whole thing on a laptop, with no cloud account at all.
 *
 *   node server/local.js
 *   → http://localhost:8787/            the Alexa+ client
 *   → http://localhost:8787/mcp         the MCP endpoint
 *
 * Same `app.js` the Edge Function serves, with the in-memory store behind it
 * instead of Postgres. Nothing is stubbed: this is the real protocol, the real
 * scheduler and the real client talking to each other.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createApp } from './app.js';
import { memoryStore } from './store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const app = createApp(memoryStore());

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/mcp') {
    // Node's http server and the Fetch API do not speak to each other, so the
    // request has to be rebuilt. Everything past this line is identical to
    // what runs in production.
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(`http://localhost:${PORT}/mcp`, {
      method: req.method,
      headers: req.headers,
      body: ['GET', 'HEAD', 'DELETE', 'OPTIONS'].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    const out = await app(request);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    if (out.body) for await (const chunk of out.body) res.write(chunk);
    return res.end();
  }

  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  try {
    const body = await readFile(join(HERE, '..', 'docs', file));
    res.writeHead(200, { 'Content-Type': TYPES[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
}).listen(PORT, () => {
  console.log(`Dwell on http://localhost:${PORT}/?server=http://localhost:${PORT}/mcp`);
});
