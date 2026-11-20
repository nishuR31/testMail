// Redis connection factory tuned for Upstash (TLS, serverless-friendly timeouts, no INFO ready-check).
import { Redis } from 'ioredis';
import { config } from './config.js';

export const redisConfigured = () => !!config.redis;

/**
 * Connection options.
 *  - blocking=true  : for BullMQ Workers. maxRetriesPerRequest MUST be null (BullMQ requirement),
 *                     and no commandTimeout because BZPOPMIN legitimately blocks for drainDelay seconds.
 *  - blocking=false : for the API/producer side. Fails fast so the UI never hangs on a dead Redis.
 */
export function redisOptions({ blocking = false } = {}) {
  const r = config.redis;
  if (!r) return null;
  return {
    host: r.host,
    port: r.port,
    username: r.username,
    password: r.password,
    db: r.db,
    tls: r.tls ? { servername: r.host } : undefined,
    // Upstash answers INFO fine, but the ready-check is a wasted command on every (re)connect.
    enableReadyCheck: false,
    maxRetriesPerRequest: blocking ? null : 2,
    connectTimeout: 15_000,
    keepAlive: 15_000,
    retryStrategy: (times) => Math.min(times * 250, 5_000),
    ...(blocking ? {} : { commandTimeout: 10_000 }),
  };
}

let client = null;
let lastErrAt = 0;
let lastErrMsg = '';

export function onRedisError(scope) {
  return (err) => {
    // ioredis emits an error per retry; keep logs readable.
    const now = Date.now();
    if (err.message !== lastErrMsg || now - lastErrAt > 10_000) {
      lastErrMsg = err.message;
      lastErrAt = now;
      console.error(`[redis:${scope}] ${err.message}`);
    }
  };
}

/** Shared non-blocking client (stats, quota, queue producers). */
export function getClient() {
  if (!config.redis) return null;
  if (!client) {
    client = new Redis(redisOptions());
    client.on('error', onRedisError('client'));
  }
  return client;
}

export const redisReady = () => !!client && client.status === 'ready';

export async function closeClient() {
  if (client) {
    try {
      await client.quit();
    } catch {
      client.disconnect();
    }
    client = null;
  }
}
