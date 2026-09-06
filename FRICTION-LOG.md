# Friction log

Writing a self-hosted MCP server — spec **2025-11-25**, Streamable HTTP — directly against the
specification, with no SDK. Six entries, worst first.

Everything below is from building [Dwell](README.md) for the Build, Ship, Shape hackathon,
Alexa+ track. The server is `server/app.js`; the conformance tests are `tests/server.test.js`.

---

## 1. The HTTP status codes a server must return are not collected anywhere

**Severity: Medium** — it does not block you, it quietly makes you non-conformant.

**Task attempted.** Implement POST, GET and DELETE on the MCP endpoint and return the right
error for each ordinary failure.

**Steps taken.** Read `/specification/2025-11-25/basic/transports` end to end, then the lifecycle
page, then the schema page.

**Expected.** A table: condition → status → body shape.

**Actual.** The statuses are all there and all correct, but they are scattered through prose —
`403` for a present-but-untrusted `Origin`, `202` for notifications and responses, `400` for a
missing `Mcp-Session-Id`, `404` for an unknown one, `400` for an unsupported
`MCP-Protocol-Version`, `406` for a bad `Accept`. Two of them are stated only as consequences of
*client* behaviour rather than as server requirements, and one is a `SHOULD` buried in a
paragraph about session lifetime.

I got 404-versus-400 for sessions wrong on the first pass. Nothing told me. A client that
should have re-initialized just failed, and it looked like my bug rather than a protocol
mistake.

**Workaround.** Derived the table by hand from the spec and wrote one conformance assertion per
status code *before* writing the handler.

**Suggestion.** Add one normative table to the transports page. It is perhaps fifteen rows, and
it would remove the single largest source of quiet incompatibility between hand-written servers.

---

## 2. There is no conformance suite or validator for a server

**Severity: High** for anyone not using an SDK.

**Task attempted.** Convince myself the server was actually 2025-11-25 conformant before
deploying it.

**Expected.** Something like `mcp validate <url>` that exercises the transport contract.

**Actual.** The inspector is built for exploring a server that already works. It does not prove
the transport edges: an untrusted `Origin`, a missing session, an unknown session, an
unsupported protocol version, a batched message, malformed JSON, a notification that must get
`202` and no body.

This is the difference between *"it works with the client I happened to test against"* and
*"it is correct"*, and today there is no way to tell which one you have.

**Workaround.** Wrote 71 assertions of my own, driving the server through real `Request` and
`Response` objects. That is the right thing to have regardless — but every hand-written server
author is now independently writing the same 71 assertions, and most will write fewer.

**Suggestion.** Publish the transport conformance cases as executable fixtures. A JSON file of
request/expected-response pairs would be enough, and would impose no runtime or language on
anyone. It would also make "MCP compliant" a checkable claim rather than a line in a README.

---

## 3. Streamable HTTP quietly assumes a long-lived process

**Severity: Medium.**

**Task attempted.** Hold a GET SSE stream open from a Supabase Edge Function.

**Expected.** Guidance for time-limited or stateless runtimes — which is where a great many MCP
servers are going to be deployed.

**Actual.** The transport is written for a process that can hold connections. Edge and
serverless runtimes have a wall-clock budget. The spec *does* bless closing the connection
without terminating the stream and letting the client poll back with `Last-Event-ID` — but that
paragraph reads as an optimisation for servers that do not want to hold sockets, rather than as
the pattern edge deployments must use. The same applies to session state: it has to live outside
the process, and nothing says so.

**Workaround.** Budget the stream to ~28 seconds, send a `retry` field, close, let the client
reconnect. Sessions in Postgres. It works well and it is entirely spec-legal.

**Suggestion.** A short "deploying to serverless and edge runtimes" note saying explicitly that
this is the supported pattern, and that session state must be externalised.

---

## 4. "An SSE event with an event ID and an empty data field" has no wire example

**Severity: Low-Medium** — get it wrong and stream resumption silently never works.

**Task attempted.** Prime the GET stream so a client can reconnect with `Last-Event-ID`.

**Expected.** The literal bytes.

**Actual.** Prose only. "An empty data field" is genuinely ambiguous between `data:\n\n`,
`data: \n\n`, and omitting the field entirely. I guessed, and there was no document that could
tell me whether I had guessed right — and nothing errors either way.

**Workaround.** Emitted `id: 1\ndata: \n\n` and asserted the exact bytes in a test, so at least
the choice is pinned and visible.

**Suggestion.** One three-line code block on that page.

---

## 5. `_meta` has no convention for UI hints, so everyone will invent one

**Severity: Low now, High later** — as soon as hosts want to render tool results richly.

**Task attempted.** Tell a client which of four cards to draw for a tool result: the step you are
on, the thing you are waiting for, the whole timeline, the shopping list.

**Actual.** `_meta` is defined and I am free to namespace a key, so I did: `dwell/ui`. Perfectly
legal, and completely non-interoperable. No host can render my results without knowing my private
key, and the next server will invent a different one.

This matters most on exactly this track. The difference between an Echo and an Echo Show is
which card gets drawn, and right now nothing in the protocol lets a server say.

**Suggestion.** Even a small non-normative registry of common `_meta` keys would stop this
fragmenting before it starts.

---

## 6. Supabase Edge Functions cannot reconstruct their own public URL

**Severity: Low** for this project; higher for anyone doing OAuth.

**Task attempted.** Have a browser `GET` on the MCP endpoint describe itself, including the URL
it lives at.

**Actual.** `/functions/v1` is stripped by the router before the request reaches the function,
and no forwarded-proto header is set — so anything derived from `req.url` is an
`http://…/dwell-mcp` that does not exist. Harmless here, since the caller already knows the URL
they used. It would break OAuth redirect construction outright.

**Related, same platform:** deploying a multi-file function is all-or-nothing. There is no way to
update one file, so a one-line change re-uploads the whole set.

**Workaround.** Stopped deriving it and removed the field.

**Suggestion.** Forward the original path and scheme, or document the canonical way to
reconstruct the public URL from inside a function.

---

## What went right

Worth saying, because a friction log that only lists friction is misleading.

The MCP specification is well written and internally consistent. I built a conformant server from
it with no SDK, no support and no examples beyond the spec itself, which is not true of most
protocols. Three decisions in it are clearly correct:

- **A POST may answer with plain JSON** instead of being forced into SSE. That single allowance is
  why this server runs on an edge function at all.
- **The session id.** It turned "remember which job I am on" from a feature I would have had to
  invent into something the protocol already provides — and it is the entire mechanism behind
  *"where was I"* working three days later with no arguments.
- **`outputSchema` plus `structuredContent`.** One payload serves both the model and the
  interface, with no parsing text back out.

Zero to hello world was about an hour. Zero to *correct* took a day, and almost all of that day
was entries 1, 2 and 4 above.
