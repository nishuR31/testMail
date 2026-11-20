// Counters, quota usage, activity log and worker heartbeats.
// Uses Redis when connected (shared by every process); otherwise process memory so "Direct" mode works with no Redis.
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { getClient, redisReady } from './redis.js';

const P = config.queue.prefix;
const K = {
  metrics: `${P}:metrics`,
  log: `${P}:log`,
  workers: `${P}:workers`,
  quota: (id, period) => `${P}:quota:${id}:${period}`,
};
const LOG_MAX = 200;
const mem = { metrics: new Map(), log: [], quota: new Map(), workers: new Map() };

export function periodKey(period, d = new Date()) {
  const iso = d.toISOString();
  return period === 'day' ? iso.slice(0, 10) : iso.slice(0, 7);
}

/* ------------------------------------------------------------------ metrics */
export async function incrMetric(mode, id, field, by = 1) {
  const f = `${mode}:${id}:${field}`;
  if (redisReady()) return void (await getClient().hincrby(K.metrics, f, by));
  mem.metrics.set(f, (mem.metrics.get(f) || 0) + by);
}

export async function getMetrics() {
  const raw = redisReady() ? await getClient().hgetall(K.metrics) : Object.fromEntries(mem.metrics);
  const out = { direct: {}, queued: {} };
  for (const [k, v] of Object.entries(raw)) {
    const [mode, id, field] = k.split(':');
    if (!out[mode]) continue;
    (out[mode][id] ??= {})[field] = Math.max(0, Number(v) || 0);
  }
  return out;
}

/* ---------------------------------------------------------------- activity */
export async function pushLog(entry) {
  const e = { id: randomUUID().slice(0, 8), ts: Date.now(), ...entry };
  if (redisReady()) {
    await getClient().pipeline().lpush(K.log, JSON.stringify(e)).ltrim(K.log, 0, LOG_MAX - 1).exec();
  } else {
    mem.log.unshift(e);
    mem.log.length = Math.min(mem.log.length, LOG_MAX);
  }
  return e;
}

export async function getLog(limit = 50) {
  if (!redisReady()) return mem.log.slice(0, limit);
  const rows = await getClient().lrange(K.log, 0, limit - 1);
  return rows
    .map((r) => {
      try {
        return JSON.parse(r);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/* ------------------------------------------------------------------- quota */
export async function getQuotaUsed(providers) {
  const withQuota = providers.filter((p) => p.quota);
  const keys = withQuota.map((p) => K.quota(p.id, periodKey(p.quota.period)));
  const values = redisReady() && keys.length ? await getClient().mget(keys) : keys.map((k) => mem.quota.get(k));
  const out = {};
  withQuota.forEach((p, i) => (out[p.id] = Number(values[i]) || 0));
  return out;
}

export async function incrQuota(provider) {
  if (!provider.quota) return;
  const key = K.quota(provider.id, periodKey(provider.quota.period));
  if (redisReady()) {
    const n = await getClient().incr(key);
    if (n === 1) await getClient().expire(key, provider.quota.period === 'day' ? 2 * 86400 : 40 * 86400);
  } else {
    mem.quota.set(key, (mem.quota.get(key) || 0) + 1);
  }
}

/* --------------------------------------------------------------- heartbeats */
export const HEARTBEAT_EVERY_MS = 60_000;
const HEARTBEAT_TTL_MS = HEARTBEAT_EVERY_MS * 2.5;

export async function heartbeat(instanceId, info) {
  const payload = JSON.stringify({ ts: Date.now(), ...info });
  // When Redis is configured always write to it (ioredis queues the command until the socket is ready);
  // a memory fallback here would make a worker invisible to the API at start-up.
  if (!config.redis) return void mem.workers.set(instanceId, JSON.parse(payload));
  await getClient().hset(K.workers, instanceId, payload);
}

export async function removeHeartbeat(instanceId) {
  mem.workers.delete(instanceId);
  if (redisReady()) await getClient().hdel(K.workers, instanceId);
}

export async function getWorkers() {
  const now = Date.now();
  const raw = redisReady() ? await getClient().hgetall(K.workers) : Object.fromEntries([...mem.workers].map(([k, v]) => [k, JSON.stringify(v)]));
  const alive = [];
  const stale = [];
  for (const [id, v] of Object.entries(raw)) {
    let w;
    try {
      w = JSON.parse(v);
    } catch {
      continue;
    }
    if (now - w.ts <= HEARTBEAT_TTL_MS) alive.push({ id, ...w });
    else if (now - w.ts > HEARTBEAT_TTL_MS * 10) stale.push(id);
  }
  if (stale.length && redisReady()) await getClient().hdel(K.workers, ...stale);
  return alive;
}

/* ------------------------------------------------------------------- reset */
export async function resetCounters() {
  mem.metrics.clear();
  mem.log.length = 0;
  if (redisReady()) await getClient().del(K.metrics, K.log);
}

export async function clearLog() {
  mem.log.length = 0;
  if (redisReady()) await getClient().del(K.log);
}
