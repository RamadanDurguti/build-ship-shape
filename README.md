# Dwell

**Most home jobs are not hard. They are just mostly waiting, and nobody plans for the waiting.**

Built for the [Build, Ship, Shape: Amazon Developer Hackathon](https://amazonappdev2026.devpost.com/) —
**Alexa+ track**, as a self-hosted MCP server (spec `2025-11-25`, Streamable HTTP) with an
Alexa+ experience on top of it.

- **Try it:** https://ramadandurguti.github.io/build-ship-shape/
- **MCP endpoint:** `https://qsgtymzjelteotcjkbol.supabase.co/functions/v1/dwell-mcp`

---

## The problem

Painting a bedroom is about **six and a half hours of actual work**. It takes **most of a weekend**.

The gap is dwell: filler going off, a coat drying, grout curing, dough proving. Time the job
needs and you do not. It is not on the tin as a task, it cannot be hurried, and it is the only
part of the job that runs while you are asleep.

That is why people get this wrong in a specific, repeatable way. They look at a six-hour job,
see a free Saturday, and start at two in the afternoon. The first coat goes on at six, and it is
Sunday lunchtime before they find out the weekend was never long enough.

An assistant in the room can hold that, and no instruction sheet can — because the answer
depends on which hours *you* have and how cold *your* room is today.

## What Dwell does

Ask it to plan a job and give it the hours you are actually free. It works out when every piece
of work happens, tells you the two numbers that matter, and then survives contact with reality:

> *"Six hours and fifty five minutes of actual work, spread over a day and a half — most of that
> is waiting for things to dry. You stop at half past four on Sunday, and it is usable Sunday at
> half past eight. Glossing the skirting will not fit — leave that for another day. Start with
> clearing the room, at 9am. Job code is moss forty one."*

Then, over the following days:

| You say | What happens |
| --- | --- |
| *"Done the filling."* | Recorded at the real time; everything downstream reschedules from there. |
| *"It's freezing in here and the windows are shut."* | Drying times stretch; it tells you how far back that pushes the finish. |
| *"Where was I?"* | Three days later, with no arguments — the session remembers the job. |
| *"Will the room be usable by Sunday teatime?"* | A real answer, including *"no, and dropping work will not help."* |
| *"What do I need to buy?"* | Quantities from the room's size, rounded up to tin sizes, minus the cupboard. |

### Two things it gets right that a chatbot does not

**It knows the difference between finishing and being finished.** "Done by six" is ambiguous:
the second coat goes on at half four, the room is not usable until half eight, and you are free
from half four. Ask about a deadline and it asks which you meant, because you can drop work to
hit one of those and you cannot hurry the other.

**It refuses to suggest a sacrifice that buys nothing.** Ask if you can finish by Sunday seven and
the honest answer is often *no — and skipping the gloss will not change that, because the finish
is set by the last coat needing four hours to dry, not by how much there is to do.* Software that
tells you to drop a coat of paint for nothing is worse than software that says nothing.

## Design

The interface is a stand-in for an Echo Show at arm's length in a hallway: one thing on screen at
a time, big enough to read from across the room, spoken as it appears.

The whole visual system is one idea. **Ochre is you** — hands on it, in the room. **Slate is the
job getting on without you.** The strip along the bottom of the screen is the entire job drawn
that way: solid where your hands are on it, hatched where it is drying, with night shaded in
because that is when most of the drying happens.

Look at that strip once and you understand the product. Six short solid blocks. A day and a half
of hatching.

The clock under the screen is not a mock. It is the `now` argument on a real tool call: move it
and the server answers for that moment, which is how a two-day story fits in a two-minute demo.

## The MCP server

A single endpoint at `/functions/v1/dwell-mcp`, speaking **MCP 2025-11-25 over Streamable HTTP**
(and `2025-06-18` for older clients).

- **POST** — one JSON-RPC message. Requests get `application/json`; notifications get `202` with
  no body. `initialize` returns an `Mcp-Session-Id`; every later request must carry it, and an
  unknown one gets a `404` so the client knows to start again.
- **GET** — opens an SSE stream, primed with an event id and an empty `data` field as the spec
  asks, with a `retry` field so the client polls back rather than the server holding a socket open
  all afternoon. It has something real to push: **the moment a coat finishes drying, it says so,
  unprompted.**
- **DELETE** — ends the session.
- `Origin` is validated and a present-but-untrusted one gets a `403`, which is what stops a random
  page from driving somebody's server through their browser.

### The seven tools

| Tool | What it is for |
| --- | --- |
| `list_jobs` | What Dwell knows how to plan. |
| `start_job` | Plan a job into the hours you are free. Returns a spoken job code. |
| `whats_next` | The one thing to do now, and what is still curing. Takes no arguments. |
| `mark_done` | Record a step at the moment it was really finished; reschedule the rest. |
| `change_the_plan` | The room turned cold, the hours changed, a step is being skipped. |
| `can_i_finish_by` | A deadline, answered honestly, measured as *usable* or *hands off*. |
| `what_to_buy` | Quantities from the room, less what is in the cupboard. |

Every tool declares an `outputSchema` and returns `structuredContent` alongside text written to
be **read out loud** — plus a `dwell/ui` hint in `_meta` telling a client which of the four cards
to draw. The three procedures are also exposed as MCP **resources** (`dwell://procedure/…`).

### State

`initialize` hands back a session id; the session remembers which job it is about. That is the
whole mechanism behind *"where was I"* working three days later with no arguments — and it is why
`whats_next` has an empty required list.

Jobs and sessions live in Postgres. Both tables have row level security on and **no policies at
all**: nothing can read them except the Edge Function, which holds the service role key. The data
surface of this system is exactly seven tools.

## The engine

`core/` is the part that earns it: dependency-free JavaScript, no model, no network, no key.

The scheduling problem is real. Work has to land inside the hours you are free; dwell runs on the
wall clock regardless, through the night. You are one person and there is one roller. Some steps
must wait for the one before to *cure*; others only need it *worked* — you pull masking tape while
the last coat is still soft, and waiting for it to cure is how you tear the paint off with the
tape. Work is contiguous on purpose: you do not paint half a wall, break for four hours and come
back, because the edge dries and it shows.

It is **critical-path list scheduling under calendar and resource constraints**. Among the steps
that are ready it starts the one with the longest chain behind it — the step that most needs a
head start is the one whose drying everything else is queued behind — with compulsory work always
ahead of optional, so the gloss never takes the last slot on a Sunday and pushes a second coat out
of the plan.

It also reports **why** each step sits where it does: after the one before, waiting on a cure, the
kit was in use, or simply that you were not free until then. A plan you can argue with.

Conditions change dwell, not work. Roughly doubling for every 10 °C below twenty, about a percent
per point of humidity over fifty, a quarter more with the windows shut — the decorators' rule of
thumb, applied only to steps that say they are weather-sensitive, and clamped at both ends.

Nothing in `core/` knows what paint is. It knows work, dwell and dependency, which is why a
sourdough loaf schedules through it unchanged — the third procedure in the library is there to
prove exactly that.

## Running it

```bash
git clone https://github.com/RamadanDurguti/build-ship-shape
cd build-ship-shape
npm test          # no install step — there are no dependencies
```

`npm test` runs both suites:

- `tests/core.test.js` — **154 assertions** over the scheduler, the conditions model and the
  quantities: overnight dwell, contiguous work, one pair of hands, kit clashes, blackouts,
  critical path, slack, resuming from real times, and every drop-to-fit case.
- `tests/server.test.js` — **71 assertions** driving the server through `Request`/`Response`
  objects on the same code path Deno serves, against an in-memory store. Half of it is transport
  conformance (session headers, `202` on notifications, `404` on an unknown session, `403` on a
  bad origin, `400` on an unsupported protocol version, the primed SSE event); the other half
  lives through a whole job — planned on Saturday, half finished, the weather turns, resumed on
  Sunday.

The server is a plain `Request -> Response` function with the store passed in
(`server/app.js`), and `server/index.ts` is five lines of Deno on top of it. That split is why the
entire MCP surface can be exercised on a laptop before anything is deployed.

### Deploying your own

```bash
# 1. the two tables
psql "$DATABASE_URL" -f supabase/migrations/0001_dwell_mcp_state.sql

# 2. the function — SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected
supabase functions deploy dwell-mcp --no-verify-jwt
```

`--no-verify-jwt` is required: MCP clients authenticate with the MCP handshake, not a Supabase
JWT. The service role key never leaves the function.

### Pointing an MCP client at it

```json
{
  "mcpServers": {
    "dwell": {
      "type": "http",
      "url": "https://qsgtymzjelteotcjkbol.supabase.co/functions/v1/dwell-mcp"
    }
  }
}
```

## Layout

```
core/      the scheduler — work, dwell, dependency, calendar. No model, no network.
server/    the MCP server: transport, the seven tools, the store. app.js is runtime-agnostic.
docs/      the Alexa+ experience, served from GitHub Pages. Talks to the live server.
tests/     225 assertions across the engine and the protocol.
supabase/  the migration.
```

## Notes on the numbers

Recoat times, filler and adhesive going off, grout and silicone curing, and the proving times in
the bread are the ordinary figures a competent tradesperson or baker would give you. Paint
coverage is 12 m² per litre per coat on sound plaster. They are written down in `core/library.js`
as data, so a procedure can be corrected without touching the scheduler.

The conditions model is a rule of thumb and is labelled as one in the code. It is not chemistry,
and it is not trying to be — it is there because a plan that assumes twenty degrees in a cold
January room is wrong by hours, and being roughly right about that beats being precisely wrong.

## Licence

MIT — see [LICENSE](LICENSE).
