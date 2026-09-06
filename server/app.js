/**
 * Dwell — a self-hosted MCP server, spec 2025-11-25, over Streamable HTTP.
 *
 * One endpoint, three methods, exactly as the transport requires:
 *
 *   POST    a single JSON-RPC message. Requests get a JSON response;
 *           notifications and responses get 202 with no body.
 *   GET     opens an SSE stream the server pushes on. Dwell has something real
 *           to push: the moment a coat finishes drying, it says so, unprompted.
 *           That is the whole point of a job that spends its time waiting.
 *   DELETE  ends the session.
 *
 * The session id returned from `initialize` is what lets the assistant answer
 * "where was I" three days later without being told anything.
 *
 * This module is a plain `Request -> Response` function with the store passed
 * in, so the entire protocol surface can be exercised locally against an
 * in-memory store before it is ever deployed.
 */
import { TOOLS, createTools } from './tools.js';
import * as library from '../core/library.js';
import * as sched from '../core/schedule.js';
import { conditions as mkConditions, window_ } from '../core/model.js';

export const LATEST = '2025-11-25';
const SUPPORTED = ['2025-11-25', '2025-06-18'];
const SERVER = { name: 'dwell', title: 'Dwell', version: '1.0.0' };

const INSTRUCTIONS = `Dwell plans domestic jobs that involve waiting — paint drying, grout curing, dough proving — around the hours someone is actually free.

Two things to hold on to. First, a job costs two different kinds of time: work, which needs the person there, and dwell, which does not. Almost every planning mistake comes from ignoring the second. Second, "done" is ambiguous: finishing the work and the room being usable can be four hours apart, so when someone gives you a deadline, find out which they mean.

Get the free hours from the person rather than assuming them. Say one step at a time — they have their hands full. Every number here is computed, so quote it exactly rather than rounding it into a guess.`;

/**
 * Browser origins allowed to talk to this server.
 *
 * Non-browser MCP clients send no Origin at all and are unaffected. The spec
 * requires a 403 only when an Origin is present and untrusted, which is what
 * stops a random page from driving somebody's server through their browser.
 */
const ALLOWED_ORIGIN =
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$|^https:\/\/[a-z0-9-]+\.github\.io$/i;

const cors = (origin) => ({
  'Access-Control-Allow-Origin': origin ?? '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'content-type, accept, mcp-session-id, mcp-protocol-version, authorization, last-event-id',
  'Access-Control-Expose-Headers': 'mcp-session-id',
  'Access-Control-Max-Age': '86400',
});

const json = (body, status, origin, extra = {}) =>
  new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', ...cors(origin), ...extra },
  });

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

// --------------------------------------------------------------- resources

const RESOURCES = library.ALL.map((p) => ({
  uri: `dwell://procedure/${p.id}`,
  name: p.id,
  title: p.title,
  description: p.summary,
  mimeType: 'text/markdown',
}));

/** The whole procedure as a document, for a client that wants to show it. */
function procedureDoc(id) {
  const p = library.get(id);
  if (!p) return null;
  const out = [`# ${p.title}`, '', p.summary, ''];
  if (p.beforeYouStart.length) {
    out.push('## Before you start', '', ...p.beforeYouStart.map((b) => `- ${b}`), '');
  }
  out.push('## Steps', '', '| Step | Work | Then it waits | After |', '| --- | --- | --- | --- |');
  for (const s of p.steps) {
    const after = [...s.needs, ...s.follows].join(', ') || '—';
    out.push(`| ${s.name}${s.optional ? ' *(optional)*' : ''} | ${s.workMin} min`
      + ` | ${s.dwellMin ? `${s.dwellMin} min` : '—'} | ${after} |`);
  }
  return out.join('\n');
}

export function createApp(store, { uuid = () => crypto.randomUUID() } = {}) {
  const callTool = createTools(store);

  async function handle(msg, sessionId) {
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params?.protocolVersion;
        return {
          protocolVersion: SUPPORTED.includes(asked) ? asked : LATEST,
          capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false, subscribe: false },
            logging: {},
          },
          serverInfo: SERVER,
          instructions: INSTRUCTIONS,
        };
      }
      case 'ping': return {};
      case 'tools/list': return { tools: TOOLS };
      case 'tools/call': return await callTool(msg.params?.name, msg.params?.arguments ?? {}, sessionId);
      case 'resources/list': return { resources: RESOURCES };
      case 'resources/templates/list': return { resourceTemplates: [] };
      case 'resources/read': {
        const uri = msg.params?.uri ?? '';
        const text = procedureDoc(uri.replace('dwell://procedure/', ''));
        if (!text) throw Object.assign(new Error(`Unknown resource: ${uri}`), { code: -32002 });
        return { contents: [{ uri, mimeType: 'text/markdown', text }] };
      }
      default:
        throw Object.assign(new Error(`Method not found: ${msg.method}`), { code: -32601 });
    }
  }

  return async function app(req) {
    const origin = req.headers.get('origin');
    const url = new URL(req.url);

    if (origin && !ALLOWED_ORIGIN.test(origin)) {
      // The spec is explicit: a present-but-untrusted Origin is a 403, and the
      // body may be a JSON-RPC error with no id.
      return json(rpcError(null, -32600, 'Origin not allowed'), 403, null);
    }
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });

    const sessionId = req.headers.get('mcp-session-id');
    const declared = req.headers.get('mcp-protocol-version');
    if (declared && !SUPPORTED.includes(declared)) {
      return json(rpcError(null, -32600, `Unsupported MCP-Protocol-Version: ${declared}`), 400, origin);
    }

    if (req.method === 'DELETE') {
      if (sessionId) await store.endSession(sessionId);
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    if (req.method === 'GET') {
      const accept = req.headers.get('accept') ?? '';
      if (!accept.includes('text/event-stream')) {
        // Not an MCP client — somebody has opened the URL in a browser. Say
        // what this is instead of returning a bare 405 at a human.
        return json({
          server: SERVER, protocol: LATEST, transport: 'streamable-http',
          endpoint: url.origin + url.pathname,
          tools: TOOLS.map((t) => t.name),
          note: 'This is an MCP endpoint. Point an MCP client at it, or open the demo client.',
        }, 200, origin);
      }
      if (!sessionId) return json(rpcError(null, -32600, 'Missing MCP-Session-Id'), 400, origin);
      const session = await store.getSession(sessionId);
      if (!session) return json(rpcError(null, -32001, 'Unknown session'), 404, origin);
      return cureStream(store, session.job_code, origin);
    }

    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: cors(origin) });
    }

    const accept = req.headers.get('accept') ?? '';
    if (accept && !accept.includes('application/json') && !accept.includes('*/*')) {
      return json(rpcError(null, -32600,
        'Accept must list application/json and text/event-stream'), 406, origin);
    }

    let msg;
    try { msg = await req.json(); }
    catch { return json(rpcError(null, -32700, 'Parse error'), 400, origin); }
    if (Array.isArray(msg)) {
      return json(rpcError(null, -32600, 'Batched messages are not part of this protocol version'), 400, origin);
    }

    const hasMethod = typeof msg?.method === 'string';
    const isRequest = hasMethod && msg.id !== undefined && msg.id !== null;
    const isNotification = hasMethod && !isRequest;

    if (isNotification || (!hasMethod && (msg?.result !== undefined || msg?.error !== undefined))) {
      if (msg?.method === 'notifications/initialized' && sessionId) {
        const s = await store.getSession(sessionId);
        if (s) await store.saveSession({ ...s, initialized: true });
      }
      return new Response(null, { status: 202, headers: cors(origin) });
    }
    if (!isRequest) return json(rpcError(null, -32600, 'Invalid Request'), 400, origin);

    if (msg.method === 'initialize') {
      const id = uuid();
      const result = await handle(msg, id);
      await store.saveSession({
        id, protocol: result.protocolVersion, client: msg.params?.clientInfo ?? {}, job_code: null,
      });
      return json({ jsonrpc: '2.0', id: msg.id, result }, 200, origin, { 'Mcp-Session-Id': id });
    }

    // Every other request has to carry the session it belongs to.
    if (!sessionId) return json(rpcError(msg.id, -32600, 'Missing MCP-Session-Id'), 400, origin);
    if (!(await store.getSession(sessionId))) {
      // 404 tells a conformant client to start a fresh session rather than
      // quietly losing the thread of the job.
      return json(rpcError(msg.id, -32001, 'Unknown session'), 404, origin);
    }

    try {
      return json({ jsonrpc: '2.0', id: msg.id, result: await handle(msg, sessionId) }, 200, origin);
    } catch (e) {
      return json(rpcError(msg.id, e?.code ?? -32603, e?.message ?? 'Internal error'), 200, origin);
    }
  };
}

/**
 * The server-initiated stream.
 *
 * A job that is drying has a next interesting moment, and it is knowable
 * exactly. So this holds the connection open until then, or for half a minute,
 * whichever comes first, and pushes a notification the moment a cure lands.
 * Then it sends a `retry` and closes, and the client reconnects — the pattern
 * the transport spec recommends over holding a socket open all afternoon.
 */
function cureStream(store, jobCode, origin, { budgetMs = 28_000, tickMs = 4000 } = {}) {
  const enc = new TextEncoder();
  let n = 0;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (s) => controller.enqueue(enc.encode(s));
      // Prime the client to reconnect, as the spec asks: an event id and an
      // empty data field before anything else.
      send(`id: ${++n}\ndata: \n\n`);
      send('retry: 3000\n\n');

      const deadline = Date.now() + budgetMs;
      const announced = new Set();

      while (Date.now() < deadline) {
        if (jobCode) {
          const job = await store.getJob(jobCode);
          const proc = job ? library.get(job.procedure_id) : null;
          if (job && proc) {
            const now = new Date();
            for (const [stepId, readyIso] of Object.entries(job.done ?? {})) {
              if (announced.has(stepId)) continue;
              const ready = new Date(readyIso);
              // Only shout about a cure that has just landed; nobody wants to
              // be told at four o'clock that something dried at eleven.
              if (ready <= now && ready.getTime() > now.getTime() - 120_000) {
                announced.add(stepId);
                const name = proc.steps.find((s) => s.id === stepId)?.name ?? stepId;
                const next = sched.build(
                  proc,
                  job.windows.map((w) => window_(new Date(w.start), new Date(w.end))),
                  mkConditions(job.conditions ?? {}),
                  { done: Object.keys(job.done), skip: job.skipped ?? [], readyAt: job.done },
                ).placed.find((p) => p.workEnd > now);
                send(`id: ${++n}\ndata: ` + JSON.stringify({
                  jsonrpc: '2.0',
                  method: 'notifications/message',
                  params: {
                    level: 'info', logger: 'dwell',
                    data: {
                      event: 'cured', job: job.code, step: stepId,
                      message: `${name} is dry.`
                        + (next ? ` You can start ${next.name.toLowerCase()} now.` : ''),
                      next: next ? { step: next.stepId, name: next.name } : null,
                    },
                  },
                }) + '\n\n');
              }
            }
          }
        }
        await new Promise((r) => setTimeout(r, tickMs));
        send(': keep-alive\n\n');
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      ...cors(origin),
    },
  });
}
