/**
 * The MCP surface, driven the way a real client drives it.
 *
 *   node tests/server.test.js
 *
 * This talks to the app through Request and Response objects — the same code
 * path Deno serves in production, with an in-memory store underneath. It
 * checks two separate things: that the transport obeys the 2025-11-25 spec
 * (session headers, status codes, origin rules, notification handling), and
 * that a whole job can be lived through — planned on Saturday, half done,
 * resumed on Sunday, replanned when the weather turns.
 */
import { createApp, LATEST } from '../server/app.js';
import { memoryStore } from '../server/store.js';

let passed = 0;
const ok = (cond, label) => {
  if (!cond) { console.error('FAILED: ' + label); process.exit(1); }
  passed++;
};

const ENDPOINT = 'https://example.test/functions/v1/dwell-mcp';
let uuidN = 0;
const app = createApp(memoryStore(), { uuid: () => `session-${++uuidN}` });

const post = (body, headers = {}) => app(new Request(ENDPOINT, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
  body: JSON.stringify(body),
}));

let rpcId = 0;
const rpc = (method, params, headers) => post({ jsonrpc: '2.0', id: ++rpcId, method, params }, headers);

// ------------------------------------------------------------- initialize
let res = await rpc('initialize', {
  protocolVersion: LATEST,
  capabilities: {},
  clientInfo: { name: 'test-harness', version: '1.0.0' },
});
ok(res.status === 200, 'initialize returns 200');
const SESSION = res.headers.get('mcp-session-id');
ok(!!SESSION, 'initialize returns an Mcp-Session-Id header');
let body = await res.json();
ok(body.result.protocolVersion === LATEST, `the negotiated version is ${LATEST}`);
ok(body.result.capabilities.tools && body.result.capabilities.resources,
  'tools and resources are both declared');
ok(typeof body.result.instructions === 'string' && body.result.instructions.length > 200,
  'the server tells the model how to behave');
ok(body.result.serverInfo.name === 'dwell', 'and identifies itself');

const S = { 'mcp-session-id': SESSION, 'mcp-protocol-version': LATEST };

// An older version the server also speaks is honoured rather than overridden.
res = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
ok((await res.json()).result.protocolVersion === '2025-06-18', 'an older supported version is accepted');
// An unknown one falls back to the latest the server speaks.
res = await rpc('initialize', { protocolVersion: '1999-01-01', capabilities: {} });
ok((await res.json()).result.protocolVersion === LATEST, 'an unknown version falls back to the latest');

// --------------------------------------------------------------- transport
res = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, S);
ok(res.status === 202, 'a notification is accepted with 202 and no body');
ok((await res.text()) === '', 'and really has no body');

res = await rpc('tools/list', {});
ok(res.status === 400, 'a request without a session id is refused');
ok((await res.json()).error.message.includes('Session'), 'and says why');

res = await rpc('tools/list', {}, { 'mcp-session-id': 'nope', 'mcp-protocol-version': LATEST });
ok(res.status === 404, 'an unknown session is a 404, so the client re-initialises');

res = await rpc('ping', {}, { 'mcp-session-id': SESSION, 'mcp-protocol-version': '2020-01-01' });
ok(res.status === 400, 'an unsupported protocol version header is a 400');

res = await app(new Request(ENDPOINT, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example', ...S },
  body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'ping' }),
}));
ok(res.status === 403, 'an untrusted Origin is refused outright');

res = await app(new Request(ENDPOINT, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'https://someone.github.io', accept: 'application/json, text/event-stream', ...S },
  body: JSON.stringify({ jsonrpc: '2.0', id: 98, method: 'ping' }),
}));
ok(res.status === 200, 'a trusted browser origin is allowed');
ok(res.headers.get('access-control-allow-origin') === 'https://someone.github.io', 'with CORS echoed back');

res = await app(new Request(ENDPOINT, { method: 'OPTIONS', headers: { origin: 'http://localhost:8000' } }));
ok(res.status === 204, 'preflight is answered');

res = await app(new Request(ENDPOINT, {
  method: 'POST', headers: { 'content-type': 'application/json', ...S }, body: '{ not json',
}));
ok(res.status === 400 && (await res.json()).error.code === -32700, 'malformed JSON is a parse error');

res = await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }], S);
ok(res.status === 400, 'batched messages are refused, as this protocol version requires');

res = await rpc('no/such/method', {}, S);
ok((await res.json()).error.code === -32601, 'an unknown method is method-not-found');

res = await app(new Request(ENDPOINT, { method: 'GET', headers: { accept: 'text/html' } }));
ok(res.status === 200 && (await res.json()).protocol === LATEST,
  'a browser opening the URL gets told what the endpoint is');

res = await app(new Request(ENDPOINT, { method: 'GET', headers: { accept: 'text/event-stream' } }));
ok(res.status === 400, 'an SSE stream without a session is refused');

res = await app(new Request(ENDPOINT, {
  method: 'GET', headers: { accept: 'text/event-stream', 'mcp-session-id': SESSION },
}));
ok(res.status === 200 && res.headers.get('content-type') === 'text/event-stream',
  'with a session, the GET opens an event stream');
{
  const reader = res.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  ok(/^id: 1\ndata: \n\n$/.test(first),
    'primed with an event id and an empty data field, as the spec asks');
  await reader.cancel();
}

// ------------------------------------------------------------------- tools
res = await rpc('tools/list', {}, S);
const tools = (await res.json()).result.tools;
ok(tools.length === 7, 'seven tools are exposed');
ok(tools.every((t) => t.inputSchema?.type === 'object'), 'every tool has an object input schema');
ok(tools.every((t) => /^[A-Za-z0-9_.-]{1,128}$/.test(t.name)), 'every name obeys the naming rules');
ok(tools.every((t) => t.description.length > 60), 'every tool explains itself properly');
ok(tools.filter((t) => t.outputSchema).length === 7, 'and declares what it returns');

res = await rpc('resources/list', {}, S);
const resources = (await res.json()).result.resources;
ok(resources.length === 3, 'each procedure is exposed as a resource');
res = await rpc('resources/read', { uri: resources[0].uri }, S);
const doc = (await res.json()).result.contents[0];
ok(doc.mimeType === 'text/markdown' && doc.text.includes('| Step |'),
  'and reads back as a document a client could show');
res = await rpc('resources/read', { uri: 'dwell://procedure/nonsense' }, S);
ok((await res.json()).error.code === -32002, 'an unknown resource is reported properly');

const callTool = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args }, S);
  return (await r.json()).result;
};

// ----------------------------------------------------- living through a job
let out = await callTool('whats_next', {});
ok(out.isError, 'asking where you were with no job on the go is an honest error');
ok(out.content[0].text.includes('Tell me what you are doing'), 'and asks for what it needs');

out = await callTool('list_jobs', {});
ok(out.structuredContent.jobs.length === 3, 'three jobs are on offer');
ok(out.content[0].text.includes('paint a room'), 'said in plain words');

const FREE = [
  { start: '2026-10-10T09:00:00+02:00', end: '2026-10-10T18:00:00+02:00' },
  { start: '2026-10-11T10:00:00+02:00', end: '2026-10-11T17:00:00+02:00' },
];
out = await callTool('start_job', {
  procedure: 'paint-a-room', free: FREE, tz: 'Europe/Belgrade',
  room: { lengthM: 4, widthM: 3.5, heightM: 2.4, openingsM2: 4 },
});
const CODE = out.structuredContent.job;
ok(!!CODE && CODE.includes('-'), 'a job comes back with a spoken code');
ok(out.structuredContent.steps.length >= 11, 'and a full plan');
ok(out._meta['dwell/ui'].card === 'timeline', 'with a hint about how to draw it');
ok(out.content[0].text.includes('of actual work'), 'the spoken plan leads with the work');
ok(out.content[0].text.includes('waiting'), 'and names the waiting straight away');
ok(out.structuredContent.waiting_minutes > out.structuredContent.hands_on_minutes,
  'because on this job there is more waiting than working');
ok(out.structuredContent.hands_off_at < out.structuredContent.usable_at,
  'and stopping work is not the same moment as the room being usable');
ok(out.structuredContent.wont_fit.includes('Gloss the skirting and frames'),
  'the gloss is flagged as the thing that will not fit');
ok(JSON.parse(out.content[1].text).job === CODE,
  'the structured result is repeated as text for older clients');

// The session now knows which job we are on, with nothing passed in.
out = await callTool('whats_next', { now: '2026-10-10T09:05:00+02:00' });
ok(out.structuredContent.job === CODE, 'the session remembers the job');
ok(out.structuredContent.state === 'ready', 'and there is something to do right now');
ok(out.structuredContent.now_do.step === 'clear', 'namely clearing the room');
ok(out.content[0].text.startsWith('Furniture to the middle'),
  'said as an instruction, not as a step number');

out = await callTool('what_to_buy', { have: { 'Wall emulsion': 5 } });
const emulsion = out.structuredContent.lines.find((l) => l.name === 'Wall emulsion');
ok(emulsion.short === 2.5, 'five litres in hand still leaves a full tin to buy');
ok(out.content[0].text.includes('2.5 litres of wall emulsion'), 'said as a shopping instruction');
ok(out._meta['dwell/ui'].card === 'shopping', 'and drawn as a list');

// Half a day in.
out = await callTool('mark_done', { step: 'clear', finished_at: '2026-10-10T09:50:00+02:00' });
ok(out.content[0].text.startsWith('Clear the room'), 'finishing a step is acknowledged');
out = await callTool('mark_done', { step: 'fill', finished_at: '2026-10-10T10:20:00+02:00' });
ok(out.content[0].text.includes('2 hours'), 'and the wait it leaves behind is said out loud');
ok(out.content[0].text.includes('ready'), 'with the moment it will be ready');

out = await callTool('whats_next', { now: '2026-10-10T10:30:00+02:00' });
ok(out.structuredContent.state === 'waiting', 'ten minutes later there is nothing to do');
ok(out.structuredContent.curing.length === 1, 'because the filler is still going off');
ok(out.content[0].text.includes('still going'), 'and it says so rather than inventing work');

// The weather turns.
out = await callTool('change_the_plan', { conditions: { tempC: 9, humidityPct: 85, ventilated: false } });
ok(out.content[0].text.includes('puts it back') || out.content[0].text.includes('does not work'),
  'a cold damp room changes the answer');

// Undo it, then ask the deadline question two ways.
await callTool('change_the_plan', { conditions: { tempC: 20, humidityPct: 50, ventilated: true } });
const usable = await callTool('can_i_finish_by', { by: '2026-10-11T19:00:00+02:00' });
ok(usable.structuredContent.fits === false, 'the room is not usable by Sunday seven');
ok(usable.structuredContent.dropped.length === 0, 'and nothing is dropped, because nothing would help');
ok(usable.content[0].text.includes('drying'), 'the drying is named as the reason');
ok(usable.content[0].text.includes('not you'), 'and the person is told it is not their fault');

const handsOff = await callTool('can_i_finish_by', { by: '2026-10-11T19:00:00+02:00', measure: 'handsOff' });
ok(handsOff.structuredContent.fits === true, 'but they can be finished working well before then');
ok(handsOff.structuredContent.measured_as === 'handsOff', 'and the answer says which it measured');

// Three days later, cold start, no arguments at all.
const laterApp = createApp(memoryStore(), { uuid: () => 'fresh' });
res = await laterApp(new Request(ENDPOINT, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST } }),
}));
ok(res.headers.get('mcp-session-id') === 'fresh', 'a brand new session starts clean');

out = await callTool('whats_next', { now: '2026-10-11T10:05:00+02:00' });
ok(out.structuredContent.job === CODE, 'the original session still knows the job the next morning');
ok(out.structuredContent.remaining_steps > 0, 'and there is still work in it');

// ----------------------------------------------------------------- teardown
res = await app(new Request(ENDPOINT, { method: 'DELETE', headers: { 'mcp-session-id': SESSION } }));
ok(res.status === 204, 'DELETE ends the session');
res = await rpc('tools/list', {}, S);
ok(res.status === 404, 'and the session really is gone');

console.log(`${passed} assertions passed`);
