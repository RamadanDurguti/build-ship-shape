/**
 * What a home project is made of.
 *
 * The distinction the whole system turns on: a step costs you two different
 * kinds of time. **Work** is time you have to be there for — a hand on a
 * roller. **Dwell** is time the job needs but you do not: filler going off,
 * a coat drying, grout curing, dough proving.
 *
 * Nobody plans badly because they cannot paint. They plan badly because
 * dwell is invisible. It does not appear on the tin as a task, it cannot be
 * hurried, and it is the only part of the job that runs while you sleep.
 * Get it wrong and a two-day job takes three weekends.
 *
 * So: work is scheduled inside the hours you actually have. Dwell runs on
 * the clock, through the night, whether you are there or not.
 */

/** The one pair of hands every attended step needs. */
export const YOU = 'you';

export const MINUTE = 60_000;

/** @param {Date} d @param {number} min */
export const plus = (d, min) => new Date(d.getTime() + min * MINUTE);

/** @param {Date} a @param {Date} b */
export const minutesBetween = (a, b) => Math.floor((b.getTime() - a.getTime()) / MINUTE);

/**
 * The room, as it actually is today.
 *
 * Dwell times printed on a tin assume roughly 20 C, half humidity and some
 * air moving. A cold damp closed-up room is not that, and the difference is
 * hours, not minutes — which is exactly the difference between finishing on
 * Sunday and not.
 *
 * The model below is the decorators' rule of thumb, not chemistry, and it is
 * applied only to steps that say they are weather-sensitive.
 */
export function conditions({ tempC = 20, humidityPct = 50, ventilated = true } = {}) {
  return { tempC, humidityPct, ventilated };
}

export function dwellMultiplier(c) {
  // Roughly doubles for every 10 C below 20.
  let m = Math.pow(2, (20 - c.tempC) / 10);
  // Each point of relative humidity above 50 adds about one percent.
  m *= 1 + Math.max(0, c.humidityPct - 50) / 100;
  if (!c.ventilated) m *= 1.25;
  return Math.max(0.5, Math.min(6, m));
}

export function describeConditions(c) {
  return `${c.tempC} C, ${c.humidityPct}% humidity, ${c.ventilated ? 'ventilated' : 'shut up'}`;
}

/**
 * One thing to do, and the wait it leaves behind.
 *
 * `needs` are steps that must be completely finished — worked *and* cured.
 * `follows` are steps whose work must be done, but whose dwell may still be
 * running. That second one is a real and separate thing: you pull masking
 * tape while the last coat is still soft, and you wash up while the loaf
 * cools. Treating every dependency as "wait for the cure" adds hours that do
 * not exist.
 */
export function step(id, name, o = {}) {
  return {
    id,
    name,
    workMin: o.workMin ?? 0,
    dwellMin: o.dwellMin ?? 0,
    needs: o.needs ?? [],
    follows: o.follows ?? [],
    // Kit that can only be in one place at a time. `you` is added always.
    uses: o.uses ?? [],
    // Things this step puts out of action while it dwells — the floor you
    // cannot walk on, the worktop you cannot use.
    holdsWhileDwelling: o.holdsWhileDwelling ?? [],
    weatherSensitive: o.weatherSensitive ?? false,
    // Steps that can come out if the time is not there. Higher importance is
    // dropped later.
    optional: o.optional ?? false,
    importance: o.importance ?? 5,
    // Said out loud when the step comes up. Written to be heard, not read.
    say: o.say ?? '',
    // What it costs to skip it. Only meaningful when optional.
    costOfSkipping: o.costOfSkipping ?? '',
  };
}

export function resourcesOf(s) {
  return s.workMin > 0 ? [YOU, ...s.uses] : [...s.uses];
}

export function dwellFor(s, c) {
  if (s.dwellMin <= 0) return 0;
  if (!s.weatherSensitive) return s.dwellMin;
  return Math.round(s.dwellMin * dwellMultiplier(c));
}

/** A stretch of time you are actually free to work. */
export function window_(start, end) {
  if (!(end > start)) throw new Error(`window ends before it starts: ${start} .. ${end}`);
  return { start, end };
}

export function windowHolds(w, start, minutes) {
  return start >= w.start && plus(start, minutes) <= w.end;
}

/** A whole job: the steps, and what the steps are made of. */
export function procedure(o) {
  return {
    id: o.id,
    title: o.title,
    summary: o.summary ?? '',
    steps: o.steps ?? [],
    materials: o.materials ?? [],
    // Shown once, at the start. The things a book would tell you.
    beforeYouStart: o.beforeYouStart ?? [],
  };
}

export function byId(proc) {
  return new Map(proc.steps.map((s) => [s.id, s]));
}

/** Catch a broken procedure before it is ever scheduled. */
export function validate(proc) {
  const problems = [];
  const ids = proc.steps.map((s) => s.id);
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) problems.push(`duplicate step id '${id}'`);
    seen.add(id);
  }
  for (const s of proc.steps) {
    if (s.workMin < 0 || s.dwellMin < 0) problems.push(`${s.id}: negative time`);
    if (s.workMin === 0 && s.dwellMin === 0) problems.push(`${s.id}: takes no time at all`);
    for (const dep of [...s.needs, ...s.follows]) {
      if (!seen.has(dep)) problems.push(`${s.id}: depends on unknown step '${dep}'`);
    }
    for (const dep of s.needs) {
      if (s.follows.includes(dep)) {
        problems.push(`${s.id}: '${dep}' is listed as both needs and follows`);
      }
    }
  }
  problems.push(...findCycles(proc.steps));
  return problems;
}

/** A procedure that depends on itself would hang the scheduler. */
function findCycles(steps) {
  const graph = new Map(steps.map((s) => [s.id, [...s.needs, ...s.follows]]));
  const state = new Map();
  const problems = new Set();

  const walk = (node, trail) => {
    if (state.get(node) === 2) return;
    if (state.get(node) === 1) {
      const cut = trail.slice(trail.indexOf(node));
      problems.add('circular dependency: ' + [...cut, node].join(' -> '));
      return;
    }
    state.set(node, 1);
    for (const next of graph.get(node) ?? []) {
      if (graph.has(next)) walk(next, [...trail, node]);
    }
    state.set(node, 2);
  };

  for (const s of steps) walk(s.id, []);
  // The same loop is found once from each of its members; keep one.
  return [...problems].sort();
}

/**
 * How much of something the job takes, worked out from the room.
 *
 * `per` is how much one unit covers, in the same units as the quantity the
 * caller passes in — square metres per litre for paint, per roll for
 * wallpaper. `soldIn` is the smallest tin or pack you can actually buy,
 * because the shop does not sell 3.4 litres.
 */
export function material(name, unit, o = {}) {
  return {
    name,
    unit,
    per: o.per ?? 1,
    soldIn: o.soldIn ?? 1,
    coats: o.coats ?? 1,
    note: o.note ?? '',
  };
}
