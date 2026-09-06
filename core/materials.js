/**
 * How much to buy, and how much of it you are short.
 *
 * Deliberately small. The only interesting judgement is that you cannot buy
 * 3.4 litres of paint: the answer has to be rounded up to the tin size, and
 * the difference between the two numbers is what stops a job at nine on a
 * Sunday morning.
 */

const roundUpTo = (value, pack) =>
  pack <= 0 ? value : Math.ceil(Number((value / pack).toFixed(6))) * pack;

/**
 * Work the quantities out from the size of the job.
 *
 * `areaM2` is the surface the job covers — wall area for painting, tiled area
 * for tiling. `have` is what is already in the cupboard, keyed by material
 * name, so the answer is a list of what to actually go and get rather than a
 * list of what the job takes.
 */
export function shoppingList(proc, areaM2, have = {}) {
  const held = new Map(Object.entries(have).map(([k, v]) => [k.toLowerCase(), Number(v)]));
  return proc.materials.map((m) => {
    const needed = m.per > 0 ? (areaM2 / m.per) * m.coats : 0;
    const toBuy = roundUpTo(needed, m.soldIn);
    const inHand = held.get(m.name.toLowerCase()) ?? 0;
    const short = Math.max(0, roundUpTo(Math.max(0, needed - inHand), m.soldIn));
    return {
      name: m.name,
      unit: m.unit,
      needed: Number(needed.toFixed(2)),
      toBuy: Number(toBuy.toFixed(2)),
      have: Number(inHand.toFixed(2)),
      short: Number(short.toFixed(2)),
      note: m.note,
    };
  });
}

/** Wall area of a rectangular room, less doors and windows. */
export const wallArea = (lengthM, widthM, heightM, openingsM2 = 0) =>
  Math.max(0, 2 * (lengthM + widthM) * heightM - openingsM2);

export const ceilingArea = (lengthM, widthM) => Math.max(0, lengthM * widthM);
