/**
 * Where a job lives between conversations.
 *
 * Two implementations behind one small interface: Postgres for the deployed
 * server, and an in-memory one so the whole MCP surface can be exercised
 * locally without a network. The interface is deliberately tiny — seven
 * methods — because everything interesting happens in the scheduler, and the
 * store should never be where a bug hides.
 */

// Words chosen to survive being said out loud down a hallway: short, no pairs
// that rhyme, nothing that sounds like a number.
const WORDS = [
  'moss', 'brick', 'copper', 'linen', 'walnut', 'slate', 'amber', 'ivy',
  'harbour', 'willow', 'cobalt', 'juniper', 'quarry', 'thistle', 'ember', 'birch',
];

export function newCode() {
  const w = WORDS[Math.floor(Math.random() * WORDS.length)];
  return `${w}-${10 + Math.floor(Math.random() * 89)}`;
}

/** Everything the server keeps, in a Map. Used by the local test harness. */
export function memoryStore() {
  const jobs = new Map();
  const sessions = new Map();
  return {
    async saveJob(job) { jobs.set(job.code, { ...job, updated_at: new Date().toISOString() }); return job; },
    async getJob(code) { return jobs.get(code) ?? null; },
    async recentJob() {
      const all = [...jobs.values()].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
      return all[0] ?? null;
    },
    async saveSession(s) { sessions.set(s.id, { ...sessions.get(s.id), ...s }); },
    async getSession(id) { return sessions.get(id) ?? null; },
    async endSession(id) { sessions.delete(id); },
    async attach(id, code) {
      const s = sessions.get(id);
      if (s) sessions.set(id, { ...s, job_code: code });
    },
  };
}

/**
 * Postgres, reached through PostgREST with the service role key.
 *
 * Both tables have row level security on and no policies at all, so the
 * publishable key that ships in the web client cannot read or write a single
 * row. This module is the only code that holds the service key, which means
 * the entire data surface is the seven tools and nothing else.
 */
export function postgrestStore(url, key) {
  const rest = (path, init = {}) =>
    fetch(`${url}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: key, Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json', ...(init.headers ?? {}),
      },
    });
  const one = async (r) => (r.ok ? (await r.json())[0] ?? null : null);

  return {
    async saveJob(job) {
      const r = await rest('dwell_job', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify([{ ...job, updated_at: new Date().toISOString() }]),
      });
      if (!r.ok) throw new Error(`saveJob ${r.status}: ${await r.text()}`);
      return (await r.json())[0];
    },
    async getJob(code) { return one(await rest(`dwell_job?code=eq.${encodeURIComponent(code)}&limit=1`)); },
    async recentJob() { return one(await rest('dwell_job?order=updated_at.desc&limit=1')); },
    async saveSession(s) {
      await rest('dwell_session', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify([{ ...s, last_seen: new Date().toISOString() }]),
      });
    },
    async getSession(id) { return one(await rest(`dwell_session?id=eq.${encodeURIComponent(id)}&limit=1`)); },
    async endSession(id) { await rest(`dwell_session?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' }); },
    async attach(id, code) {
      await rest(`dwell_session?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ job_code: code, last_seen: new Date().toISOString() }),
      });
    },
  };
}
