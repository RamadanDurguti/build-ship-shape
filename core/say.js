/**
 * Turning a plan into something worth hearing.
 *
 * A voice assistant has no scrollback. Everything it says is gone the moment
 * it is said, so a spoken plan cannot be a list — it has to be one thing at a
 * time, in the order a person needs it, with the number they will act on put
 * last where it lands.
 *
 * These helpers are the difference between "step 7 of 12, dwell 240 minutes"
 * and "roll the ceiling now, then it wants four hours — so the walls are a
 * tomorrow job." Same data. Only one of them is any use with your hands full.
 */
import { minutesBetween } from './model.js';

const DAY = 24 * 60;

const fmt = (d, tz, opts) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...opts }).format(d);

/** Clock time the way it is spoken: "ten past three", "half nine", "10am". */
export function clockWords(d, tz) {
  const h24 = Number(fmt(d, tz, { hour: '2-digit', hour12: false }));
  const m = Number(fmt(d, tz, { minute: '2-digit' }));
  const h12 = ((h24 + 11) % 12) + 1;
  const suffix = h24 < 12 ? 'am' : 'pm';
  if (m === 0) return `${h12}${suffix}`;
  if (m === 30) return `half past ${h12}`;
  if (m === 15) return `quarter past ${h12}`;
  if (m === 45) return `quarter to ${((h12 % 12) + 1)}`;
  return `${h12}:${String(m).padStart(2, '0')}${suffix}`;
}

const ordinal = (n) => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th'}`;
};

/**
 * Which day, relative to now, in the words a person would use.
 *
 * The calendar day is taken in the job's own time zone, not the server's —
 * "tomorrow" has to mean tomorrow in the room being painted.
 */
export function dayWords(d, now, tz) {
  // en-CA gives YYYY-MM-DD, which is both sortable and safely parseable.
  const key = (x) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(x);
  if (key(d) === key(now)) return 'today';
  const days = Math.round((Date.parse(key(d)) - Date.parse(key(now))) / 86_400_000);
  const weekday = fmt(d, tz, { weekday: 'long' });
  if (days === 1) return 'tomorrow';
  if (days > 1 && days < 7) return weekday;
  if (days === 7) return `${weekday} week`;
  return `${weekday} the ${ordinal(Number(fmt(d, tz, { day: 'numeric' })))}`;
}

/** "tomorrow at half past ten" — the whole moment, said once. */
export function whenWords(d, now, tz) {
  const day = dayWords(d, now, tz);
  const hour = Number(fmt(d, tz, { hour: '2-digit', hour12: false }));
  const part = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  if (day === 'today') return `at ${clockWords(d, tz)}`;
  if (day === 'tomorrow') return `tomorrow ${part} at ${clockWords(d, tz)}`;
  return `${day} at ${clockWords(d, tz)}`;
}

/** Durations rounded the way people say them, never "247 minutes". */
export function durationWords(min) {
  if (min < 1) return 'no time at all';
  if (min < 60) return `${Math.round(min)} minutes`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h >= 24) {
    const d = Math.round(min / DAY);
    return d === 1 ? 'a day' : `${d} days`;
  }
  if (m === 0) return h === 1 ? 'an hour' : `${h} hours`;
  if (m === 30) return h === 1 ? 'an hour and a half' : `${h} and a half hours`;
  return `${h} ${h === 1 ? 'hour' : 'hours'} and ${m} minutes`;
}

/** The plain-English reason a step sits where it sits. */
export function whyWords(placed, nameOf) {
  switch (placed.why) {
    case 'dwell':   return `${nameOf(placed.because)} had to dry first`;
    case 'after':   return `it comes straight after ${nameOf(placed.because).toLowerCase()}`;
    case 'calendar':return 'it is the first time you are free';
    case 'resource':return placed.because === 'you'
      ? 'you were busy with something else'
      : `the ${placed.because} was in use`;
    default:        return 'nothing was in its way';
  }
}
