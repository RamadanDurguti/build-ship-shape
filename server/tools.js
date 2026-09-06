/**
 * The seven things Alexa+ can actually do with a job.
 *
 * Every one is shaped for a voice turn rather than a screen. The text in
 * `content` is written to be read out loud and nothing else; the same facts go
 * back as `structuredContent` for anything that wants to draw them, and a
 * `dwell/ui` hint in `_meta` says which card fits.
 *
 * None of these tools computes anything. They collect what the person said,
 * hand it to the scheduler, and turn the answer back into English.
 */
import * as library from '../core/library.js';
import * as materials from '../core/materials.js';
import * as sched from '../core/schedule.js';
import { byId, conditions as mkConditions, window_ } from '../core/model.js';
import { clockWords, durationWords, whenWords, whyWords } from '../core/say.js';
import { newCode } from './store.js';

const PROCEDURE_IDS = library.ALL.map((p) => p.id);
const iso = (d) => d.toISOString();
const asDate = (s) => new Date(s);

const windowsOf = (job) => job.windows.map((w) => window_(asDate(w.start), asDate(w.end)));
const conditionsOf = (job) => mkConditions(job.conditions ?? {});
const nameOf = (proc) => (id) => byId(proc).get(id)?.name ?? id;

function planFor(job) {
  const proc = library.get(job.procedure_id);
  if (!proc) throw new Error(`unknown procedure '${job.procedure_id}'`);
  return {
    proc,
    plan: sched.build(proc, windowsOf(job), conditionsOf(job), {
      done: Object.keys(job.done ?? {}),
      skip: job.skipped ?? [],
      readyAt: job.done ?? {},
    }),
  };
}

/** One placed step, flattened for anything that wants to draw it. */
const wire = (p, proc, tz, now) => ({
  step: p.stepId, name: p.name, say: p.say,
  start: iso(p.workStart), end: iso(p.workEnd), ready_at: iso(p.readyAt),
  work_minutes: p.workMin, dwell_minutes: p.dwellMin, optional: p.optional,
  when: whenWords(p.workStart, now, tz),
  because: whyWords(p, nameOf(proc)),
});

const shape = (plan, proc, tz, now) => ({
  hands_on_minutes: sched.handsOnMin(plan),
  waiting_minutes: sched.waitingMin(plan),
  hands_off_at: sched.planHandsOff(plan) ? iso(sched.planHandsOff(plan)) : null,
  usable_at: sched.planFinish(plan) ? iso(sched.planFinish(plan)) : null,
  steps: plan.placed.map((p) => wire(p, proc, tz, now)),
  wont_fit: plan.wontFit.map(nameOf(proc)),
  will_not_fit_at_all: plan.unplaceable.map(nameOf(proc)),
  blackouts: plan.blackouts.map((b) => ({ what: b.what, from: iso(b.from), to: iso(b.to) })),
  critical_path: plan.criticalPath,
});

// -------------------------------------------------------------- definitions

const FREE_HOURS = {
  type: 'array',
  description:
    'The stretches of time the person is actually free to work, in order. Each is an '
    + 'ISO 8601 start and end with a UTC offset. Ask for real hours rather than '
    + 'guessing: "Saturday nine to six, Sunday ten to four".',
  items: {
    type: 'object',
    properties: {
      start: { type: 'string', description: 'ISO 8601 with offset, e.g. 2026-10-10T09:00:00+02:00' },
      end: { type: 'string', description: 'ISO 8601 with offset' },
    },
    required: ['start', 'end'], additionalProperties: false,
  },
};

const CONDITIONS = {
  type: 'object',
  description:
    'What the room is like today. Worth asking about when the person mentions it — '
    + 'cold, damp, windows shut. Drying times move a long way on this.',
  properties: {
    tempC: { type: 'number', description: 'Room temperature in celsius. Default 20.' },
    humidityPct: { type: 'number', description: 'Relative humidity, 0-100. Default 50.' },
    ventilated: { type: 'boolean', description: 'Is there air moving through. Default true.' },
  },
  additionalProperties: false,
};

const ROOM = {
  type: 'object',
  description: 'Room size, needed only to work out quantities.',
  properties: {
    lengthM: { type: 'number' }, widthM: { type: 'number' }, heightM: { type: 'number' },
    openingsM2: { type: 'number', description: 'Doors and windows, in square metres.' },
  },
  additionalProperties: false,
};

const PLAN_OUT = {
  type: 'object',
  properties: {
    job: { type: 'string' }, title: { type: 'string' },
    hands_on_minutes: { type: 'number' }, waiting_minutes: { type: 'number' },
    hands_off_at: { type: ['string', 'null'] }, usable_at: { type: ['string', 'null'] },
    steps: { type: 'array', items: { type: 'object' } },
    wont_fit: { type: 'array', items: { type: 'string' } },
    will_not_fit_at_all: { type: 'array', items: { type: 'string' } },
    blackouts: { type: 'array', items: { type: 'object' } },
    critical_path: { type: 'array', items: { type: 'string' } },
  },
  required: ['job', 'title', 'hands_on_minutes', 'waiting_minutes', 'steps'],
  additionalProperties: true,
};

export const TOOLS = [
  {
    name: 'list_jobs',
    title: 'What Dwell can plan',
    description:
      'The jobs Dwell knows how to schedule, and what each one involves. Call this if '
      + 'the person has not named something recognisable.',
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: {
      type: 'object', properties: { jobs: { type: 'array', items: { type: 'object' } } },
      required: ['jobs'], additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'start_job',
    title: 'Plan a job into the hours you have',
    description:
      'Work out when every part of a job happens, given the hours the person is free. '
      + 'Returns a short spoken job code — use it on later calls about this job. Always '
      + 'get the free hours from the person; never invent them.',
    inputSchema: {
      type: 'object',
      properties: {
        procedure: { type: 'string', enum: PROCEDURE_IDS, description: 'Which job.' },
        free: FREE_HOURS,
        tz: { type: 'string', description: 'IANA time zone of the room, e.g. Europe/Belgrade.' },
        conditions: CONDITIONS,
        room: ROOM,
      },
      required: ['procedure', 'free'], additionalProperties: false,
    },
    outputSchema: PLAN_OUT,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'whats_next',
    title: 'Where was I',
    description:
      'The one thing to do now, what is still curing, and when the next thing can start. '
      + 'This is the answer to "where was I" days later, and it needs no arguments — the '
      + 'session remembers which job.',
    inputSchema: {
      type: 'object',
      properties: {
        job: { type: 'string', description: 'Job code. Omit to use the current job.' },
        now: { type: 'string', description: 'ISO 8601 now, if not the server clock.' },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        job: { type: 'string' }, title: { type: 'string' },
        state: { type: 'string', enum: ['ready', 'waiting', 'idle', 'finished'] },
        now_do: { type: ['object', 'null'] },
        curing: { type: 'array', items: { type: 'object' } },
        remaining_steps: { type: 'number' }, usable_at: { type: ['string', 'null'] },
      },
      required: ['job', 'state', 'remaining_steps'], additionalProperties: true,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'mark_done',
    title: 'Record that a step is finished',
    description:
      'Record a step as done at the moment it was actually finished, and reschedule '
      + 'everything after it from there. Use this whenever the person says they have '
      + 'finished something — the rest of the plan moves to match.',
    inputSchema: {
      type: 'object',
      properties: {
        step: { type: 'string', description: 'The step id, from the plan.' },
        job: { type: 'string' },
        finished_at: { type: 'string', description: 'ISO 8601. Defaults to now.' },
      },
      required: ['step'], additionalProperties: false,
    },
    outputSchema: PLAN_OUT,
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: 'change_the_plan',
    title: 'Something changed',
    description:
      'Reschedule when reality moves: the room turned cold, a window got shut, the hours '
      + 'changed, a step is being skipped. Says what moved and what it cost.',
    inputSchema: {
      type: 'object',
      properties: {
        job: { type: 'string' }, free: FREE_HOURS, conditions: CONDITIONS,
        skip: { type: 'array', items: { type: 'string' },
                description: 'Step ids the person has decided not to do.' },
        unskip: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    outputSchema: PLAN_OUT,
    annotations: { readOnlyHint: false, idempotentHint: false },
  },
  {
    name: 'can_i_finish_by',
    title: 'Can I be done by then',
    description:
      'Answer a deadline. Says whether it fits, and if not, either what to drop and what '
      + 'that costs, or — often — that dropping work would not help because the finish is '
      + 'set by drying time. Find out whether they mean finished working or the room being '
      + 'usable; they are hours apart and the answer differs.',
    inputSchema: {
      type: 'object',
      properties: {
        by: { type: 'string', description: 'ISO 8601 deadline.' },
        job: { type: 'string' },
        measure: {
          type: 'string', enum: ['usable', 'handsOff'],
          description:
            'usable: the last coat has cured and the room is back in use. handsOff: the '
            + 'person has stopped working and can leave it to dry. Default usable.',
        },
      },
      required: ['by'], additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        job: { type: 'string' }, fits: { type: 'boolean' }, over_by_minutes: { type: 'number' },
        dropped: { type: 'array', items: { type: 'string' } },
        consequences: { type: 'array', items: { type: 'string' } },
        note: { type: 'string' }, measured_as: { type: 'string' },
        hands_off_at: { type: ['string', 'null'] }, usable_at: { type: ['string', 'null'] },
      },
      required: ['job', 'fits'], additionalProperties: true,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'what_to_buy',
    title: 'What to buy, and how short you are',
    description:
      'Quantities worked out from the size of the room, rounded up to what the shop '
      + 'actually sells, minus whatever is already in the cupboard. Being half a litre '
      + 'short still costs a whole tin, and this says so.',
    inputSchema: {
      type: 'object',
      properties: {
        job: { type: 'string' }, room: ROOM,
        area_m2: { type: 'number', description: 'Use instead of room, if known directly.' },
        have: {
          type: 'object', description: 'What is already in the cupboard, by material name.',
          additionalProperties: { type: 'number' },
        },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        job: { type: 'string' }, area_m2: { type: 'number' },
        lines: { type: 'array', items: { type: 'object' } },
      },
      required: ['job', 'lines'], additionalProperties: true,
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
];

// ------------------------------------------------------------------ handlers

const ui = (card, extra = {}) => ({ 'dwell/ui': { card, ...extra } });

const reply = (spoken, data, card, extra = {}) => ({
  content: [
    { type: 'text', text: spoken },
    // The spec asks for the structured payload to be repeated as text for
    // clients that predate structuredContent.
    { type: 'text', text: JSON.stringify(data) },
  ],
  structuredContent: data,
  _meta: ui(card, extra),
});

const fail = (spoken) => ({
  content: [{ type: 'text', text: spoken }], isError: true, _meta: ui('answer'),
});

export function createTools(store) {
  const need = async (args, sessionId) => {
    let job = null;
    if (args.job) job = await store.getJob(args.job);
    else {
      const s = sessionId ? await store.getSession(sessionId) : null;
      job = s?.job_code ? await store.getJob(s.job_code) : await store.recentJob();
    }
    if (!job) throw new Error('NO_JOB');
    return job;
  };

  return async function call(name, args = {}, sessionId = null) {
    const now = args?.now ? asDate(args.now) : new Date();
    try {
      switch (name) {
        case 'list_jobs': {
          const jobs = library.ALL.map((p) => ({
            id: p.id, title: p.title, summary: p.summary, steps: p.steps.length,
            hands_on_minutes: p.steps.reduce((n, s) => n + s.workMin, 0),
            longest_wait_minutes: Math.max(...p.steps.map((s) => s.dwellMin)),
          }));
          return reply(
            'I can plan ' + jobs.map((j) => j.title.toLowerCase()).join(', ')
            + '. Which one, and when are you free?', { jobs }, 'answer');
        }

        case 'start_job': {
          const proc = library.get(args.procedure);
          if (!proc) return fail(`I do not know how to plan ${args.procedure}.`);
          if (!args.free?.length) return fail('I need to know when you are free before I can plan it.');

          const tz = args.tz || 'Europe/Belgrade';
          const area = args.room
            ? materials.wallArea(args.room.lengthM ?? 0, args.room.widthM ?? 0,
                                 args.room.heightM ?? 0, args.room.openingsM2 ?? 0)
            : null;
          const job = {
            code: newCode(), procedure_id: proc.id, title: proc.title,
            windows: args.free, conditions: mkConditions(args.conditions ?? {}),
            done: {}, skipped: [], area_m2: area, have: {}, tz,
          };
          await store.saveJob(job);
          await store.attach(sessionId, job.code);

          const { plan } = planFor(job);
          return reply(spokenPlan(plan, proc, job, now),
            { job: job.code, title: proc.title, ...shape(plan, proc, tz, now) },
            'timeline', { code: job.code, before_you_start: proc.beforeYouStart });
        }

        case 'whats_next': {
          const job = await need(args, sessionId);
          await store.attach(sessionId, job.code);
          const { proc, plan } = planFor(job);
          const tz = job.tz;

          const curing = Object.entries(job.done ?? {})
            .map(([id, at]) => ({ id, at: asDate(at) }))
            .filter((c) => c.at > now)
            .sort((a, b) => a.at - b.at)
            .map((c) => ({
              step: c.id, name: nameOf(proc)(c.id), ready_at: iso(c.at),
              ready_in_minutes: Math.round((c.at.getTime() - now.getTime()) / 60000),
            }));

          const upcoming = plan.placed.filter((p) => p.workEnd > now);
          const doable = upcoming.find((p) => p.workStart <= now) ?? upcoming[0] ?? null;
          const usable = sched.planFinish(plan);

          if (!doable) {
            const finished = Object.keys(job.done ?? {}).length >= proc.steps.length - (job.skipped?.length ?? 0);
            return reply(
              finished ? `That is ${proc.title.toLowerCase()} finished.`
                       : 'There is nothing left in the plan for the hours you gave me.',
              { job: job.code, title: proc.title, state: finished ? 'finished' : 'idle',
                now_do: null, curing, remaining_steps: 0,
                usable_at: usable ? iso(usable) : null },
              'answer', { code: job.code });
          }

          const ready = doable.workStart <= now;
          const spoken = ready
            ? [doable.say || doable.name,
               doable.dwellMin > 0 ? `Then it wants ${durationWords(doable.dwellMin)}.` : ''
              ].filter(Boolean).join(' ')
            : curing.length
              ? `Nothing yet — ${curing[0].name.toLowerCase()} is still going, `
                + `another ${durationWords(curing[0].ready_in_minutes)}. `
                + `${doable.name} can start ${whenWords(doable.workStart, now, tz)}.`
              : `Next is ${doable.name.toLowerCase()}, ${whenWords(doable.workStart, now, tz)}.`;

          return reply(spoken, {
            job: job.code, title: proc.title, state: ready ? 'ready' : 'waiting',
            now_do: wire(doable, proc, tz, now), curing,
            remaining_steps: upcoming.length, usable_at: usable ? iso(usable) : null,
          }, ready ? 'step' : 'waiting', { code: job.code });
        }

        case 'mark_done': {
          const job = await need(args, sessionId);
          const proc = library.get(job.procedure_id);
          const step = byId(proc).get(args.step);
          if (!step) return fail(`There is no step called ${args.step} in this job.`);

          const at = args.finished_at ? asDate(args.finished_at) : now;
          // The dwell is whatever today's conditions make it, not the number
          // on the tin — the room is the room.
          const dwell = sched.build(proc, windowsOf(job), conditionsOf(job))
            .placed.find((p) => p.stepId === step.id)?.dwellMin ?? step.dwellMin;
          const readyAt = new Date(at.getTime() + dwell * 60000);

          job.done = { ...(job.done ?? {}), [step.id]: iso(readyAt) };
          await store.saveJob(job);
          await store.attach(sessionId, job.code);

          const { plan } = planFor(job);
          const next = plan.placed.find((p) => p.workEnd > now) ?? null;
          const spoken = [
            `${step.name} down.`,
            dwell > 0 ? `That needs ${durationWords(dwell)} — ready ${whenWords(readyAt, now, job.tz)}.` : '',
            next ? `Next is ${next.name.toLowerCase()}, ${whenWords(next.workStart, now, job.tz)}.`
                 : 'That is everything.',
          ].filter(Boolean).join(' ');

          return reply(spoken, { job: job.code, title: proc.title, ...shape(plan, proc, job.tz, now) },
            'timeline', { code: job.code, just_finished: step.id });
        }

        case 'change_the_plan': {
          const job = await need(args, sessionId);
          const proc = library.get(job.procedure_id);
          const wasUsable = sched.planFinish(planFor(job).plan);

          if (args.free?.length) job.windows = args.free;
          if (args.conditions) job.conditions = mkConditions({ ...job.conditions, ...args.conditions });
          if (args.skip?.length) job.skipped = [...new Set([...(job.skipped ?? []), ...args.skip])];
          if (args.unskip?.length) job.skipped = (job.skipped ?? []).filter((s) => !args.unskip.includes(s));
          await store.saveJob(job);
          await store.attach(sessionId, job.code);

          const { plan } = planFor(job);
          const nowUsable = sched.planFinish(plan);
          let spoken;
          if (!sched.planOk(plan)) {
            spoken = `That does not work. ${plan.unplaceable.map(nameOf(proc)).slice(0, 2).join(' and ')} `
              + 'will not fit in the time you have left.';
          } else if (wasUsable && nowUsable) {
            const moved = Math.round((nowUsable.getTime() - wasUsable.getTime()) / 60000);
            spoken = moved === 0
              ? `No change — still done ${whenWords(nowUsable, now, job.tz)}.`
              : moved > 0
                ? `That puts it back ${durationWords(moved)}. Done ${whenWords(nowUsable, now, job.tz)} instead.`
                : `That brings it forward ${durationWords(-moved)}, to ${whenWords(nowUsable, now, job.tz)}.`;
          } else spoken = 'Replanned.';
          if (plan.wontFit.length) {
            spoken += ` ${plan.wontFit.map(nameOf(proc)).join(' and ')} will not fit — that needs another evening.`;
          }

          return reply(spoken, { job: job.code, title: proc.title, ...shape(plan, proc, job.tz, now) },
            'timeline', { code: job.code, changed: true });
        }

        case 'can_i_finish_by': {
          const job = await need(args, sessionId);
          const proc = library.get(job.procedure_id);
          const by = asDate(args.by);
          const measure = args.measure === 'handsOff' ? 'handsOff' : 'usable';
          const f = sched.fitBy(proc, windowsOf(job), by, conditionsOf(job), {
            done: Object.keys(job.done ?? {}), skip: job.skipped ?? [],
            readyAt: job.done ?? {}, measure,
          });
          const handsOff = sched.planHandsOff(f.plan);
          const usable = sched.planFinish(f.plan);

          let spoken;
          if (f.fits && !f.dropped.length) {
            spoken = 'Yes, comfortably. ' + (measure === 'handsOff'
              ? `You would be done ${whenWords(handsOff, now, job.tz)}.`
              : `The room is back ${whenWords(usable, now, job.tz)}.`);
          } else if (f.fits) {
            spoken = `Only if you drop ${f.dropped.map(nameOf(proc)).join(' and ').toLowerCase()}. `
              + f.consequences.join(' ');
          } else if (f.note) {
            spoken = `No — about ${durationWords(f.overByMin)} short. ${f.note}`;
          } else {
            spoken = `No. You are ${durationWords(f.overByMin)} over, even after dropping `
              + `${f.dropped.map(nameOf(proc)).join(' and ').toLowerCase()}.`;
          }
          // The most useful sentence in the whole product: you were finished
          // hours ago, it is the paint that is still going.
          if (measure === 'usable' && !f.fits && handsOff && handsOff <= by) {
            spoken += ` You would have stopped working by ${clockWords(handsOff, job.tz)} though — `
              + 'it is the drying that runs over, not you.';
          }

          return reply(spoken, {
            job: job.code, fits: f.fits, over_by_minutes: f.overByMin,
            dropped: f.dropped.map(nameOf(proc)), consequences: f.consequences,
            note: f.note ?? '', measured_as: measure,
            hands_off_at: handsOff ? iso(handsOff) : null,
            usable_at: usable ? iso(usable) : null,
            ...shape(f.plan, proc, job.tz, now),
          }, 'answer', { code: job.code, verdict: f.fits ? 'yes' : 'no' });
        }

        case 'what_to_buy': {
          const job = await need(args, sessionId);
          const proc = library.get(job.procedure_id);
          const area = args.area_m2 ?? (args.room
            ? materials.wallArea(args.room.lengthM ?? 0, args.room.widthM ?? 0,
                                 args.room.heightM ?? 0, args.room.openingsM2 ?? 0)
            : job.area_m2);
          if (!area) return fail('I need the size of the room first — how long, how wide, how high?');
          if (args.have) job.have = { ...(job.have ?? {}), ...args.have };
          job.area_m2 = area;
          await store.saveJob(job);

          const lines = materials.shoppingList(proc, Number(area), job.have ?? {});
          const short = lines.filter((l) => l.short > 0);
          const spoken = !proc.materials.length
            ? 'That job has no materials list.'
            : short.length === 0
              ? 'You have everything you need.'
              : 'You need ' + short.map((l) => `${l.short} ${l.unit} of ${l.name.toLowerCase()}`).join(', ') + '.';
          return reply(spoken, { job: job.code, area_m2: Number(Number(area).toFixed(1)), lines },
            'shopping', { code: job.code });
        }

        default:
          return fail(`I do not have a tool called ${name}.`);
      }
    } catch (e) {
      if (String(e).includes('NO_JOB')) {
        return fail('I do not have a job on the go. Tell me what you are doing and when you are free.');
      }
      return fail(`Something went wrong: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
}

/**
 * The opening summary — the one place worth spending three sentences.
 *
 * It leads with the split between working and waiting, because that is the
 * fact that changes what someone does next, and it is the fact no instruction
 * sheet ever tells them.
 */
function spokenPlan(plan, proc, job, now) {
  const tz = job.tz;
  const bits = [
    `${durationWords(sched.handsOnMin(plan))} of actual work, spread over `
    + `${durationWords(sched.elapsedMin(plan))} — most of that is waiting for things to dry.`,
  ];
  if (!sched.planOk(plan)) {
    bits.push(`It does not fit: ${plan.unplaceable.map(nameOf(proc)).slice(0, 2).join(' and ')} `
      + 'has nowhere to go. You need more hours than that.');
  } else {
    bits.push(`You stop ${whenWords(sched.planHandsOff(plan), now, tz)}, and it is usable `
      + `${whenWords(sched.planFinish(plan), now, tz)}.`);
  }
  if (plan.wontFit.length) {
    bits.push(`${plan.wontFit.map(nameOf(proc)).join(' and ')} will not fit — leave that for another day.`);
  }
  const first = plan.placed[0];
  if (first) bits.push(`Start with ${first.name.toLowerCase()}, ${whenWords(first.workStart, now, tz)}.`);
  bits.push(`Job code is ${job.code.replace('-', ' ')}.`);
  return bits.join(' ');
}
