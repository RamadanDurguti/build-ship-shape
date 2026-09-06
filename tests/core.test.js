/**
 * Assertions over the scheduler, the conditions model and the quantities.
 *
 *   node tests/core.test.js      (also runs unchanged under `deno run`)
 */
import * as library from '../core/library.js';
import * as materials from '../core/materials.js';
import * as sched from '../core/schedule.js';
import { conditions, dwellFor, dwellMultiplier, material, plus, procedure, resourcesOf, step, validate, window_ } from '../core/model.js';

let passed = 0;
const ok = (cond, label) => {
  if (!cond) { console.error('FAILED: ' + label); process.exit(1); }
  passed++;
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

const D = new Date('2026-10-10T09:00:00');            // a Saturday morning
const at = (day, hour, min = 0) => new Date(2026, 9, day, hour, min);
const satSun = (satFrom = 9, satTo = 18, sunFrom = 10, sunTo = 17) =>
  [window_(at(10, satFrom), at(10, satTo)), window_(at(11, sunFrom), at(11, sunTo))];

// ---------------------------------------------------------------- conditions
ok(near(dwellMultiplier(conditions()), 1), '20C/50%/vented is the reference case');
ok(dwellMultiplier(conditions({ tempC: 10 })) > 1.9, 'ten degrees colder roughly doubles dwell');
ok(dwellMultiplier(conditions({ tempC: 30 })) < 0.6, 'ten degrees warmer roughly halves it');
ok(dwellMultiplier(conditions({ humidityPct: 80 })) > 1.29, 'damp air extends dwell');
ok(dwellMultiplier(conditions({ ventilated: false })) === 1.25, 'shutting the window costs a quarter');
ok(dwellMultiplier(conditions({ tempC: -40 })) === 6, 'the multiplier is clamped at the top');
ok(dwellMultiplier(conditions({ tempC: 99 })) === 0.5, 'and at the bottom');

const sensitive = step('x', 'X', { workMin: 10, dwellMin: 100, weatherSensitive: true });
ok(dwellFor(sensitive, conditions({ tempC: 10 })) === 200, 'sensitive dwell scales');
ok(dwellFor(step('y', 'Y', { workMin: 10, dwellMin: 100 }), conditions({ tempC: 10 })) === 100,
  'insensitive dwell does not');
ok(JSON.stringify(resourcesOf(sensitive)) === '["you"]', 'attended work always occupies you');
ok(JSON.stringify(resourcesOf(step('z', 'Z', { dwellMin: 60, uses: ['oven'] }))) === '["oven"]',
  'an unattended step does not occupy you');

// ---------------------------------------------------------------- validation
ok(validate(procedure({ id: 'b', title: 'B', steps: [step('a', 'A', { workMin: 5, needs: ['nope'] })] }))
  .some((p) => p.includes('unknown step')), 'unknown dependency is caught');
ok(validate(procedure({ id: 'l', title: 'L', steps: [
  step('a', 'A', { workMin: 5, needs: ['b'] }), step('b', 'B', { workMin: 5, needs: ['a'] })] }))
  .some((p) => p.includes('circular')), 'a cycle is caught');
ok(validate(procedure({ id: 'd', title: 'D', steps: [
  step('a', 'A', { workMin: 5 }), step('a', 'A2', { workMin: 5 })] }))
  .some((p) => p.includes('duplicate')), 'duplicate ids are caught');
ok(validate(procedure({ id: 'e', title: 'E', steps: [step('a', 'A')] }))
  .some((p) => p.includes('no time')), 'a step with no time at all is caught');
ok(validate(procedure({ id: 'x', title: 'X', steps: [
  step('a', 'A', { workMin: 5 }),
  step('b', 'B', { workMin: 5, needs: ['a'], follows: ['a'] })] }))
  .some((p) => p.includes('both needs and follows')), 'a contradictory dependency is caught');
try { window_(D, new Date(D.getTime() - 3600e3)); ok(false, 'a backwards window should not build'); }
catch { ok(true, 'a backwards window is rejected'); }

// ------------------------------------------------------------ basic sequence
const seq = procedure({ id: 's', title: 'S', steps: [
  step('one', 'One', { workMin: 60 }),
  step('two', 'Two', { workMin: 60, needs: ['one'] })] });
let p = sched.build(seq, [window_(D, plus(D, 480))]);
ok(sched.planOk(p), 'a simple sequence schedules');
ok(+sched.planStep(p, 'one').workStart === +D, 'the first step starts at the top of the window');
ok(+sched.planStep(p, 'two').workStart === +plus(D, 60), 'the second follows immediately');
ok(+sched.planFinish(p) === +plus(D, 120), 'and the finish is the end of the last one');
ok(sched.handsOnMin(p) === 120, 'hands-on time is the sum of the work');
ok(sched.waitingMin(p) === 0, 'with no dwell there is nothing to wait for');
ok(sched.planStep(p, 'two').why === sched.AFTER_STEP, 'step two waited on step one');

// -------------------------------------------------------- dwell runs overnight
const overnight = procedure({ id: 'o', title: 'O', steps: [
  step('glue', 'Glue', { workMin: 30, dwellMin: 1440 }),
  step('after', 'After', { workMin: 30, needs: ['glue'] })] });
p = sched.build(overnight, satSun());
ok(+sched.planStep(p, 'glue').workStart === +at(10, 9), 'the long-dwell step goes first');
ok(+sched.planStep(p, 'glue').readyAt === +plus(at(10, 9), 1470), 'dwell ignores the calendar');
ok(sched.planStep(p, 'after').workStart.getDate() === 11, 'the dependent step lands the next day');
ok(sched.planStep(p, 'after').why === sched.WAITING_DWELL, 'and knows it was waiting on a cure');
ok(sched.planStep(p, 'after').because === 'glue', 'and knows what it was waiting on');
ok(sched.planStep(p, 'after').delayedBy === sched.NO_TIME,
  'while also recording that the calendar held it up a further half hour');
ok(sched.waitingMin(p) > sched.handsOnMin(p), 'on this job most of the elapsed time is waiting');

// ----------------------------------------------- work never splits a window
p = sched.build(procedure({ id: 't', title: 'T', steps: [step('big', 'Big', { workMin: 600 })] }), satSun());
ok(!sched.planOk(p) && p.unplaceable.join() === 'big', 'work that fits no single window is reported');
p = sched.build(procedure({ id: 't2', title: 'T2', steps: [step('big', 'Big', { workMin: 540 })] }), satSun());
ok(sched.planOk(p) && +sched.planStep(p, 'big').workStart === +at(10, 9),
  'work exactly filling a window is placed');
p = sched.build(procedure({ id: 't3', title: 'T3', steps: [step('big', 'Big', { workMin: 541 })] }), satSun());
ok(!sched.planOk(p), 'one minute over the window is not squeezed in');

// --------------------------------------------------------- one pair of hands
p = sched.build(procedure({ id: 'p', title: 'P', steps: [
  step('a', 'A', { workMin: 120 }), step('b', 'B', { workMin: 120 })] }), [window_(D, plus(D, 480))]);
const starts = p.placed.map((x) => +x.workStart).sort((a, b) => a - b);
ok(starts[1] === starts[0] + 120 * 60000, 'two jobs cannot be done at once by one person');

// ------------------------------------------------------- kit is a constraint
p = sched.build(procedure({ id: 'k', title: 'K', steps: [
  step('wait', 'Wait', { workMin: 10, dwellMin: 240, uses: ['roller'] }),
  step('other', 'Other', { workMin: 10 }),
  step('roll', 'Roll', { workMin: 10, uses: ['roller'], needs: ['other'] })] }),
  [window_(D, plus(D, 600))]);
ok(sched.planOk(p) && p.placed.length === 3, 'the kit job schedules');

p = sched.build(procedure({ id: 'h', title: 'H', steps: [
  step('tile', 'Tile', { workMin: 60, dwellMin: 1440, uses: ['worktop'], holdsWhileDwelling: ['worktop'] })] }),
  satSun());
ok(p.blackouts.length === 1, 'a curing step blocks what it holds');
ok(p.blackouts[0].what === 'worktop' && (p.blackouts[0].to - p.blackouts[0].from) === 1500 * 60000,
  'the blackout covers the work and the whole cure');

// ------------------------------------------------- critical path and priority
// `slow` has a long chain behind it; `quick` does not. Slow must go first even
// though both are ready at the same moment.
p = sched.build(procedure({ id: 'pr', title: 'PR', steps: [
  step('slow', 'Slow', { workMin: 30, dwellMin: 600 }),
  step('slow2', 'Slow2', { workMin: 30, needs: ['slow'] }),
  step('quick', 'Quick', { workMin: 30 })] }), [window_(D, plus(D, 1200))]);
ok(sched.planStep(p, 'slow').workStart < sched.planStep(p, 'quick').workStart,
  'the step with the longest tail is started first');
ok(p.criticalPath[0] === 'slow' && p.criticalPath.at(-1) === 'slow2',
  'the critical path is the chain that sets the finish');
ok(p.slackMin.quick > 0, 'the step off the critical path has slack');
ok(p.slackMin.slow2 === 0, 'the last step on the path has none');

// ------------------------------------------------------- the painting weekend
const full = sched.build(library.PAINT_A_ROOM, satSun());
ok(sched.planOk(full), 'every compulsory part of the painting job fits a weekend');
ok(full.wontFit.join() === 'woodwork', 'the gloss is the one thing there is no room for');
ok(+sched.planStep(full, 'unmask').workStart === +sched.planStep(full, 'walls_2').workEnd,
  'the tape comes off the moment the last coat is on, not after it cures');
ok(full.criticalPath[0] === 'clear' && full.criticalPath.at(-1) === 'walls_2',
  'the critical path runs from clearing the room to the final coat');
ok(sched.handsOnMin(full) === 415, 'the job is just under seven hours of actual work');
ok(sched.waitingMin(full) > sched.handsOnMin(full) * 3,
  'and more than three times that in waiting');

// ---------------------------------------------------------------- resuming
const half = ['clear', 'fill', 'sand', 'wash'];
const resumed = sched.build(library.PAINT_A_ROOM, satSun(), conditions(),
  { done: half, readyAt: { wash: at(10, 13) } });
ok(!resumed.placed.some((x) => half.includes(x.stepId)), 'finished steps do not reappear');
ok(sched.planStep(resumed, 'mask').workStart >= at(10, 13),
  'the resumed plan starts from when the last finished step actually became ready');
const accounted = new Set([...resumed.placed.map((x) => x.stepId), ...resumed.wontFit, ...resumed.unplaceable]);
const expected = library.PAINT_A_ROOM.steps.map((s) => s.id).filter((i) => !half.includes(i));
ok(expected.every((i) => accounted.has(i)) && accounted.size === expected.length,
  'every remaining step is either planned or explicitly accounted for');
ok(sched.planOk(resumed), 'and the compulsory remainder still fits');

// -------------------------------------------------- conditions change the plan
const roomy = Array.from({ length: 6 }, (_, n) => window_(at(10 + n, 9), at(10 + n, 18)));
const warm = sched.build(library.PAINT_A_ROOM, roomy, conditions({ tempC: 22, humidityPct: 45 }));
const cold = sched.build(library.PAINT_A_ROOM, roomy, conditions({ tempC: 9, humidityPct: 85, ventilated: false }));
ok(sched.planOk(warm) && sched.planOk(cold), 'both schedule when there is enough time');
ok(sched.planFinish(cold) > sched.planFinish(warm), 'a cold damp shut-up room finishes later');
ok(sched.handsOnMin(cold) === sched.handsOnMin(warm), 'but the work itself is unchanged');
ok(sched.waitingMin(cold) > sched.waitingMin(warm), 'the whole difference is waiting');

const weekendWarm = sched.build(library.PAINT_A_ROOM, satSun(), conditions({ tempC: 22, humidityPct: 45 }));
const weekendCold = sched.build(library.PAINT_A_ROOM, satSun(), conditions({ tempC: 9, humidityPct: 85, ventilated: false }));
ok(sched.planOk(weekendWarm), 'in a warm dry room the weekend is enough');
ok(!sched.planOk(weekendCold), 'in a cold damp one it is not, and the plan says so');
ok(weekendCold.unplaceable.includes('ceiling_1'), 'naming the compulsory work that will not fit');

// ------------------------------------------------------------- fitting a deadline
const tight = sched.fitBy(library.PAINT_A_ROOM, satSun(), at(11, 15),
  conditions({ tempC: 9, humidityPct: 85, ventilated: false }));
ok(tight.dropped.length > 0, 'a tight deadline in bad conditions forces something out');
ok(tight.dropped[tight.dropped.length - 1] === 'woodwork' || tight.dropped.includes('woodwork'),
  'the least important optional step goes first');
ok(tight.consequences.every((c) => c.length > 0), 'and every drop is explained');
ok(tight.dropped.every((d) => library.PAINT_A_ROOM.steps.find((s) => s.id === d).optional),
  'nothing compulsory is ever silently dropped');

const generous = sched.fitBy(library.PAINT_A_ROOM, satSun(), at(13, 20));
ok(generous.fits && generous.dropped.length === 0, 'a generous deadline drops nothing');

const impossible = sched.fitBy(library.PAINT_A_ROOM, satSun(), at(10, 10));
ok(!impossible.fits, 'an impossible deadline is reported as such');
ok(impossible.overByMin > 0, 'with a real number of minutes over');

// The finish here is set by the last coat drying, not by the workload — so
// there is nothing worth dropping, and the plan says so instead of inventing
// a sacrifice that buys nothing.
const justShort = sched.fitBy(library.PAINT_A_ROOM, satSun(), at(11, 19));
ok(!justShort.fits, 'an hour short of the drying time is still short');
ok(justShort.dropped.length === 0, 'and nothing is dropped, because nothing would help');
ok(justShort.note.includes('will not help'), 'the reason is said plainly');
ok(justShort.note.toLowerCase().includes('dry'), 'and names the drying as the constraint');

// Measured by when you can stop working rather than when it is usable, the
// same weekend and the same deadline are comfortably fine.
const handsOff = sched.fitBy(library.PAINT_A_ROOM, satSun(), at(11, 19), conditions(), { measure: 'handsOff' });
ok(handsOff.fits, 'you can be finished working long before the room is usable');
ok(+sched.planHandsOff(handsOff.plan) < +sched.planFinish(handsOff.plan),
  'hands off is always earlier than done');

// Where the workload really is the constraint, dropping does happen.
const shortDay = sched.fitBy(library.PAINT_A_ROOM,
  [window_(at(10, 9), at(10, 18)), window_(at(11, 10), at(11, 14))], at(11, 22));
ok(shortDay.dropped.length === 0 || shortDay.dropped.every(
  (d) => library.PAINT_A_ROOM.steps.find((s) => s.id === d).optional),
  'anything dropped is always optional');

// ---------------------------------------------------------- other procedures
for (const proc of library.ALL) ok(validate(proc).length === 0, `${proc.id} is a valid procedure`);

const tiles = sched.build(library.TILE_A_SPLASHBACK, satSun());
ok(sched.planOk(tiles), 'tiling schedules');
ok(sched.planFinish(tiles) > at(12, 0), 'two 24-hour cures push it past the weekend');
ok(tiles.blackouts.some((b) => b.what === 'worktop'), 'the worktop is blacked out');

// Saturday evening and Sunday morning — how anyone actually bakes.
const bread = sched.build(library.SOURDOUGH, [window_(at(10, 17), at(10, 23)), window_(at(11, 8), at(11, 13))]);
ok(sched.planOk(bread), 'the same engine schedules a loaf of bread with no changes');
ok(sched.planStep(bread, 'bake').workStart.getDate() === 11, 'the bake lands the morning after');
ok(sched.planStep(bread, 'cold_proof').readyAt.getDate() === 11, 'the proof runs through the night');
ok(+sched.planStep(bread, 'cool').workStart === +sched.planStep(bread, 'bake').workEnd,
  'the loaf comes out the moment it is baked, and cools on its own time');

// ---------------------------------------------------------------- materials
const area = materials.wallArea(4, 3.5, 2.4, 4);
ok(near(area, 32), 'wall area subtracts the door and window');
ok(materials.ceilingArea(4, 3.5) === 14, 'ceiling area is length by width');

const lines = materials.shoppingList(library.PAINT_A_ROOM, area);
const emulsion = lines.find((l) => l.name === 'Wall emulsion');
ok(near(emulsion.needed, Number(((32 / 12) * 2).toFixed(2)), 0.01), 'two coats at twelve m2 a litre');
ok(emulsion.toBuy === 7.5, 'rounded up to whole 2.5 litre tins');
ok(emulsion.short === emulsion.toBuy, 'with nothing in the cupboard you buy all of it');
ok(materials.shoppingList(library.PAINT_A_ROOM, area, { 'wall emulsion': 5 })
  .find((l) => l.name === 'Wall emulsion').short === 2.5, 'five litres in hand leaves one more tin');
ok(materials.shoppingList(library.PAINT_A_ROOM, area, { 'Wall emulsion': 100 })
  .find((l) => l.name === 'Wall emulsion').short === 0, 'plenty in hand means nothing to buy');
ok(materials.shoppingList(library.PAINT_A_ROOM, area, { 'wall emulsion': 5.2 })
  .find((l) => l.name === 'Wall emulsion').short === 2.5,
  'being a fraction short still costs a full tin');

// ------------------------------------------------------- plans are reproducible
const a1 = sched.build(library.PAINT_A_ROOM, satSun(), conditions({ tempC: 16, humidityPct: 60 }));
const a2 = sched.build(library.PAINT_A_ROOM, satSun(), conditions({ tempC: 16, humidityPct: 60 }));
ok(JSON.stringify(a1.placed) === JSON.stringify(a2.placed),
  'the same inputs always give exactly the same plan');

// ------------------------------------------------------------ every step lands
for (const proc of library.ALL) {
  const wide = Array.from({ length: 8 }, (_, n) => window_(at(10 + n, 8), at(10 + n, 20)));
  const pl = sched.build(proc, wide);
  ok(sched.planOk(pl), `${proc.id} places every step given enough time`);
  ok(pl.placed.length === proc.steps.length, `${proc.id} loses nothing`);
  for (const x of pl.placed) {
    const s = proc.steps.find((q) => q.id === x.stepId);
    ok(s.needs.every((d) => x.workStart >= sched.planStep(pl, d).readyAt),
      `${proc.id}/${x.stepId} never starts before its dependencies have cured`);
    ok(s.follows.every((d) => x.workStart >= sched.planStep(pl, d).workEnd),
      `${proc.id}/${x.stepId} never starts before the step it follows is worked`);
  }
}

console.log(`${passed} assertions passed`);
