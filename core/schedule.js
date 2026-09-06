/**
 * Fit a job into the hours a person actually has.
 *
 * This is the part that earns the product. Given a step graph, the hours
 * someone is free, and the state of the room, it decides when each piece of
 * work happens — and, when it will not fit, says what specifically to drop
 * and what that costs.
 *
 * The algorithm is critical-path list scheduling under two constraints that
 * household plans always break on:
 *
 *   - work only happens inside the windows you are free; dwell runs on the
 *     wall clock regardless, including overnight
 *   - you are one person, and there is one roller
 *
 * Among the steps that are ready, it always starts the one with the longest
 * remaining chain behind it. That is the standard heuristic and it is the
 * right one here: the step that most needs a head start is the one whose
 * dwell everything else is queued behind.
 *
 * No model runs in this file. Every time in a plan is arithmetic over the
 * procedure and the calendar, which is what makes a plan something you can
 * argue with rather than something you have to trust.
 */
import {
  byId, conditions as defaultConditions, dwellFor, minutesBetween, plus,
  resourcesOf, validate, windowHolds,
} from './model.js';

// Why a step starts when it does. Naming this is most of what makes a plan
// feel explicable out loud rather than arbitrary.
export const AFTER_STEP = 'after';      // the step before it had just finished working
export const WAITING_DWELL = 'dwell';   // its dependency was still drying or curing
export const NO_TIME = 'calendar';      // you were not free until then
export const RESOURCE = 'resource';     // you, or the kit, were busy
export const FIRST = 'start';           // nothing was in its way

/**
 * Earliest contiguous slot of `minutes` that satisfies everything.
 *
 * Work is contiguous on purpose. You do not paint half a wall, break for
 * four hours, and come back — the edge dries and it shows. A scheduler that
 * split work would produce plans that look fine and fail in the room.
 *
 * The earliest legal start is always one of: the moment the step became
 * ready, the start of some window, or the end of some interval that was
 * blocking it. Checking exactly those is both complete and small.
 */
function earliestSlot(minutes, notBefore, resources, busy, windows) {
  if (minutes <= 0) return notBefore;

  const candidates = new Map([[notBefore.getTime(), notBefore]]);
  const offer = (t) => {
    if (t >= notBefore) candidates.set(t.getTime(), t);
  };
  for (const w of windows) if (w.end > notBefore) offer(w.start > notBefore ? w.start : notBefore);
  for (const r of resources) for (const [, end] of busy.get(r) ?? []) offer(end);

  for (const start of [...candidates.values()].sort((a, b) => a - b)) {
    if (!windows.some((w) => windowHolds(w, start, minutes))) continue;
    const end = plus(start, minutes);
    let clash = false;
    for (const r of resources) {
      for (const [bStart, bEnd] of busy.get(r) ?? []) {
        if (bStart < end && start < bEnd) { clash = true; break; }
      }
      if (clash) break;
    }
    if (!clash) return start;
  }
  return null;
}

/**
 * Longest remaining path from each step to the end, in minutes.
 *
 * This is the priority. A step with three coats and two overnight cures
 * behind it has to go first even if it is quick, and this number is how the
 * scheduler knows.
 */
function tails(proc, cond) {
  const steps = byId(proc);
  const successors = new Map(proc.steps.map((s) => [s.id, []]));
  for (const s of proc.steps) {
    for (const dep of [...s.needs, ...s.follows]) {
      if (successors.has(dep)) successors.get(dep).push(s.id);
    }
  }
  const memo = new Map();
  const tail = (id) => {
    if (memo.has(id)) return memo.get(id);
    const s = steps.get(id);
    const own = s.workMin + dwellFor(s, cond);
    const after = successors.get(id).map(tail);
    const best = own + (after.length ? Math.max(...after) : 0);
    memo.set(id, best);
    return best;
  };
  for (const s of proc.steps) tail(s.id);
  return memo;
}

/**
 * A step that cannot be placed takes everything downstream with it.
 *
 * Reporting only the step that failed would leave a plan that quietly
 * schedules the tape coming off before the second coat goes on.
 */
function withDependents(stepId, proc, skip) {
  const out = new Set([stepId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of proc.steps) {
      if (out.has(s.id) || skip.has(s.id)) continue;
      if ([...s.needs, ...s.follows].some((d) => out.has(d))) { out.add(s.id); changed = true; }
    }
  }
  return out;
}

/** Which resource, if any, was occupied over the gap we had to wait out. */
function blockingResource(start, notBefore, resources, busy) {
  for (const r of resources) {
    for (const [bStart, bEnd] of busy.get(r) ?? []) {
      if (bStart < start && bEnd > notBefore) return r;
    }
  }
  return '';
}

/**
 * Schedule a procedure into a set of windows.
 *
 * `done` are steps already finished — passing them is how a plan is resumed
 * on day two without replanning the past. `readyAt` carries the real moment a
 * finished step's dwell actually ends, which is rarely the moment the
 * original plan predicted.
 */
export function build(proc, windows, cond = defaultConditions(), opts = {}) {
  const done = new Set(opts.done ?? []);
  const skip = new Set(opts.skip ?? []);
  const readyAt = new Map(Object.entries(opts.readyAt ?? {}).map(([k, v]) => [k, new Date(v)]));

  const problems = validate(proc);
  if (problems.length) throw new Error(problems.join('; '));

  const sorted = [...windows].sort((a, b) => a.start - b.start);
  const steps = byId(proc);
  const tailOf = tails(proc, cond);

  const plan = {
    placed: [],
    dropped: [...skip].sort(),
    // Compulsory work there is no room for. A plan with any of these is not
    // a plan, it is a warning.
    unplaceable: [],
    // Optional work there is no room for. Not a failure — a fact to say out
    // loud: everything that matters fits, the gloss needs another evening.
    wontFit: [],
    blackouts: [],
    criticalPath: [],
    slackMin: {},
    conditions: cond,
  };

  const busy = new Map();
  const finished = new Map(readyAt);   // cured and touchable
  const worked = new Map(readyAt);     // hands off, may still be curing
  const earliest = sorted.length ? sorted[0].start : new Date(0);

  /** When this step could first begin, or null while a dependency is unscheduled. */
  const dependencyReady = (s) => {
    let latest = null;
    let why = FIRST;
    let because = '';
    for (const dep of s.needs) {
      if (skip.has(dep)) continue;
      if (!finished.has(dep)) return null;
      const when = finished.get(dep);
      if (latest === null || when > latest) {
        latest = when; because = dep;
        why = dwellFor(steps.get(dep), cond) > 0 ? WAITING_DWELL : AFTER_STEP;
      }
    }
    for (const dep of s.follows) {
      if (skip.has(dep)) continue;
      if (!worked.has(dep)) return null;
      const when = worked.get(dep);
      if (latest === null || when > latest) { latest = when; because = dep; why = AFTER_STEP; }
    }
    const at = latest === null ? earliest : (latest > earliest ? latest : earliest);
    return { at, why, because };
  };

  let remaining = proc.steps.filter((s) => !done.has(s.id) && !skip.has(s.id));
  let guard = 0;

  while (remaining.length) {
    if (++guard > proc.steps.length * proc.steps.length + 50) {
      plan.unplaceable = remaining.map((s) => s.id);
      break;
    }

    const ready = [];
    for (const s of remaining) {
      const r = dependencyReady(s);
      if (r) ready.push({ s, ...r });
    }
    if (!ready.length) { plan.unplaceable = remaining.map((s) => s.id); break; }

    // Compulsory work first, then the longest chain. Without the first key an
    // optional step with a long tail will take the last slot on a Sunday
    // afternoon and push a second coat out of the plan entirely, which is
    // exactly backwards.
    ready.sort((a, b) =>
      (a.s.optional === b.s.optional ? 0 : a.s.optional ? 1 : -1) ||
      (tailOf.get(b.s.id) - tailOf.get(a.s.id)) ||
      (a.at - b.at) ||
      a.s.id.localeCompare(b.s.id));

    const { s, at: notBefore } = ready[0];
    let { why, because } = ready[0];
    const res = resourcesOf(s);
    const start = earliestSlot(s.workMin, notBefore, res, busy, sorted);

    if (start === null) {
      const stuck = withDependents(s.id, proc, skip);
      const bucket = [...stuck].every((i) => steps.get(i).optional) ? plan.wontFit : plan.unplaceable;
      bucket.push(...[...stuck].sort());
      remaining = remaining.filter((x) => !stuck.has(x.id));
      continue;
    }

    const delayedMin = minutesBetween(notBefore, start);
    let delayedBy = '';
    if (delayedMin > 0) {
      // Distinguish "no free hours" from "the kit was in use".
      const clash = blockingResource(start, notBefore, res, busy);
      delayedBy = clash || NO_TIME;
      if (why === FIRST) {
        // Nothing upstream held it back, so the delay is the reason.
        why = clash ? RESOURCE : NO_TIME;
        because = clash;
      }
    }

    const end = plus(start, s.workMin);
    const dwell = dwellFor(s, cond);
    const readyMoment = plus(end, dwell);

    for (const r of res) {
      if (!busy.has(r)) busy.set(r, []);
      busy.get(r).push([start, end]);
    }
    for (const r of s.holdsWhileDwelling) {
      if (!busy.has(r)) busy.set(r, []);
      busy.get(r).push([start, readyMoment]);
      plan.blackouts.push({ what: r, from: start, to: readyMoment });
    }

    plan.placed.push({
      stepId: s.id,
      name: s.name,
      workStart: start,
      workEnd: end,
      readyAt: readyMoment,
      workMin: s.workMin,
      dwellMin: dwell,
      why,
      because,
      say: s.say,
      // Extra delay on top of the dependency wait, and what caused it. A step
      // can be held up twice over — the paint needed four hours and then you
      // were not free until ten — and both halves are worth saying out loud.
      delayedMin,
      delayedBy,
      optional: s.optional,
    });
    finished.set(s.id, readyMoment);
    worked.set(s.id, end);
    remaining = remaining.filter((x) => x.id !== s.id);
  }

  plan.placed.sort((a, b) => (a.workStart - b.workStart) || a.stepId.localeCompare(b.stepId));
  plan.criticalPath = criticalPath(plan);
  plan.slackMin = slack(plan, proc, skip);
  return plan;
}

export const planStep = (plan, id) => plan.placed.find((p) => p.stepId === id) ?? null;
/** True when every compulsory step has a slot. */
export const planOk = (plan) => plan.unplaceable.length === 0;
/**
 * When the job is done in the sense of usable — the last cure has finished.
 * This is "when can we move the furniture back", not "when can I stop".
 */
export const planFinish = (plan) =>
  plan.placed.length ? new Date(Math.max(...plan.placed.map((p) => p.readyAt))) : null;

/**
 * When your hands come off it for the last time.
 *
 * These two are not the same and the difference is the whole product. The
 * second coat goes on at three; the room is not usable until seven; you are
 * free from three. A deadline means one or the other and it matters which,
 * because you can drop work to hit the first and you cannot hurry the second.
 */
export const planHandsOff = (plan) =>
  plan.placed.length ? new Date(Math.max(...plan.placed.map((p) => p.workEnd))) : null;
export const planFirstStart = (plan) =>
  plan.placed.length ? new Date(Math.min(...plan.placed.map((p) => p.workStart))) : null;
export const handsOnMin = (plan) => plan.placed.reduce((n, p) => n + p.workMin, 0);
export const elapsedMin = (plan) =>
  plan.placed.length ? minutesBetween(planFirstStart(plan), planFinish(plan)) : 0;
/** Time the job is running and you are not. The invisible part. */
export const waitingMin = (plan) => Math.max(0, elapsedMin(plan) - handsOnMin(plan));

/**
 * The chain that actually decides the finish time.
 *
 * Walk back from whatever finishes last, each time to the dependency that was
 * still going when this step could first have started. Steps whose start was
 * set by the calendar rather than by another step end the chain — they are the
 * honest answer to "what is holding this up": nothing is, you were at work.
 */
function criticalPath(plan) {
  if (!plan.placed.length) return [];
  let cursor = plan.placed.reduce((a, b) => (b.readyAt > a.readyAt ? b : a));
  const chain = [cursor.stepId];
  const seen = new Set(chain);
  while (cursor.because && !seen.has(cursor.because)) {
    const next = planStep(plan, cursor.because);
    if (!next) break;
    chain.push(next.stepId);
    seen.add(next.stepId);
    cursor = next;
  }
  return chain.reverse();
}

/**
 * How long each step could be put off without moving the finish.
 *
 * Measured against the schedule as built, which is the number a person can act
 * on: "you have two hours of give on the woodwork" is useful; a theoretical
 * bound over every possible schedule is not.
 */
function slack(plan, proc, skip) {
  const successors = new Map(proc.steps.map((s) => [s.id, []]));
  for (const s of proc.steps) {
    if (skip.has(s.id)) continue;
    for (const dep of s.needs) {
      if (successors.has(dep) && !skip.has(dep)) successors.get(dep).push([s.id, true]);
    }
    for (const dep of s.follows) {
      if (successors.has(dep) && !skip.has(dep)) successors.get(dep).push([s.id, false]);
    }
  }
  const finish = planFinish(plan);
  const out = {};
  for (const p of plan.placed) {
    let give = null;
    for (const [nextId, needsCure] of successors.get(p.stepId) ?? []) {
      const q = planStep(plan, nextId);
      if (!q) continue;
      // A successor that only needs the work done gives you slack from the
      // moment your hands come off, not from the end of the cure.
      const mine = needsCure ? p.readyAt : p.workEnd;
      const room = minutesBetween(mine, q.workStart);
      give = give === null ? room : Math.min(give, room);
    }
    if (give === null) give = minutesBetween(p.readyAt, finish ?? p.readyAt);
    out[p.stepId] = Math.max(0, give);
  }
  return out;
}

/**
 * Schedule it; if it runs past the deadline, drop the least important optional
 * steps until it does not — and say what each one costs.
 *
 * Dropping is done one at a time, cheapest first, rescheduling in between,
 * because removing a step changes the critical path. Dropping the three that
 * looked spare in the original plan usually removes one more than necessary,
 * and the extra one is a coat of paint.
 */
export function fitBy(proc, windows, deadline, cond = defaultConditions(), opts = {}) {
  // "usable" is when the last cure ends; "handsOff" is when you can walk away
  // and let it dry. Which one the deadline means changes the answer entirely.
  const measure = opts.measure === 'handsOff' ? planHandsOff : planFinish;
  const base = build(proc, windows, cond, opts);
  const baseAt = measure(base);
  if (planOk(base) && baseAt && baseAt <= deadline) {
    return { fits: true, plan: base, deadline, overByMin: 0, dropped: [], consequences: [],
             impossible: false, note: '' };
  }

  const steps = byId(proc);
  const done = new Set(opts.done ?? []);
  const optional = proc.steps
    .filter((s) => s.optional && !done.has(s.id))
    .sort((a, b) => (a.importance - b.importance) || a.id.localeCompare(b.id));

  const dropped = new Set();
  let plan = base;
  const explain = () => [...dropped].sort().map(
    (d) => steps.get(d).costOfSkipping || `${steps.get(d).name} will not be done.`);

  for (const candidate of optional) {
    dropped.add(candidate.id);
    plan = build(proc, windows, cond, { ...opts, skip: [...dropped] });
    const f = measure(plan);
    if (planOk(plan) && f && f <= deadline) {
      return { fits: true, plan, deadline, overByMin: 0, dropped: [...dropped].sort(),
               consequences: explain(), impossible: false, note: '' };
    }
  }

  // Nothing worked. Before reporting a pile of sacrifices, check whether they
  // bought anything at all — because very often they do not. When the finish
  // is set by the last coat drying rather than by how much work there is,
  // dropping the gloss moves nothing, and telling someone to skip it anyway is
  // worse than useless. In that case give the untrimmed plan back and say what
  // is actually in the way.
  const trimmedAt = measure(plan);
  const noGain = planOk(base) && baseAt && trimmedAt && trimmedAt >= baseAt;
  if (noGain) {
    const tail = base.criticalPath.at(-1);
    const last = tail ? planStep(base, tail) : null;
    return {
      fits: false, plan: base, deadline,
      overByMin: Math.max(0, minutesBetween(deadline, baseAt)),
      dropped: [], consequences: [], impossible: false,
      note: last && last.dwellMin > 0
        ? `Dropping work will not help. The finish is set by ${last.name.toLowerCase()} `
          + `needing ${Math.round(last.dwellMin / 60)} hours to dry, not by how much there is to do.`
        : 'Dropping the optional work would not bring the finish forward.',
    };
  }

  return {
    fits: false,
    plan,
    deadline,
    overByMin: trimmedAt ? Math.max(0, minutesBetween(deadline, trimmedAt)) : 0,
    dropped: [...dropped].sort(),
    consequences: explain(),
    impossible: !planOk(plan),
    note: '',
  };
}
