// Load balancer: every email goes to the provider whose queue would finish it soonest.
//   estimated wait = (pending jobs + 1) / requests-per-second
// A provider with an empty queue and a slow rate limit therefore loses to a fast provider with a short backlog,
// and a provider that has run out of free-tier quota is skipped entirely.

/**
 * @param {number} count          emails to place
 * @param {Array}  pool           provider objects
 * @param {Record<string, number>} pending  current backlog per provider id
 * @param {Record<string, number>} remaining free-tier quota left per provider id (missing = unlimited)
 * @returns {{assignments: string[], unassigned: number}}
 */
export function plan(count, pool, pending, remaining = {}) {
  const load = Object.fromEntries(pool.map((p) => [p.id, pending[p.id] || 0]));
  const cap = Object.fromEntries(pool.map((p) => [p.id, remaining[p.id] ?? Infinity]));
  const assignments = [];
  for (let i = 0; i < count; i++) {
    let best = null;
    let bestScore = Infinity;
    for (const p of pool) {
      if (cap[p.id] <= 0) continue;
      const score = (load[p.id] + 1) / Math.max(p.rps, 0.01);
      if (score < bestScore - 1e-9) {
        best = p;
        bestScore = score;
      }
    }
    if (!best) break;
    assignments.push(best.id);
    load[best.id] += 1;
    cap[best.id] -= 1;
  }
  return { assignments, unassigned: count - assignments.length };
}

export function summarize(assignments, providers) {
  const n = {};
  for (const id of assignments) n[id] = (n[id] || 0) + 1;
  return Object.entries(n)
    .map(([id, c]) => `${providers.find((p) => p.id === id)?.label ?? id} x${c}`)
    .join(', ');
}
