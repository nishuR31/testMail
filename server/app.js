import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serveStatic } from '@hono/node-server/serve-static';
import { config } from './config.js';
import { HttpError } from './errors.js';
import { enabledProviders, readyProviders } from './providers/index.js';
import { getClient, redisReady } from './redis.js';
import { parseSendBody } from './validate.js';
import { runDirect, directInflight } from './direct.js';
import { summarize } from './balancer.js';
import * as queue from './queue.js';
import * as store from './store.js';
import { maskHost } from './util.js';

const insecure = config.isProd && !config.accessToken && !/^(1|true)$/i.test(process.env.ALLOW_INSECURE || '');
const maxBody = Math.ceil(config.maxAttachmentBytes * 1.4) + 64 * 1024;

export const app = new Hono();

/* ---------------------------------------------------------------- security */
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cross-Origin-Opener-Policy', 'same-origin');
  if (c.req.path.startsWith('/api/')) c.header('Cache-Control', 'no-store');
});

const safeEqual = (a, b) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/health') return next();
  if (insecure) {
    return c.json({ error: 'ACCESS_TOKEN is required when NODE_ENV=production (set ALLOW_INSECURE=true to override)', code: 'insecure' }, 503);
  }
  if (config.accessToken) {
    const bearer = (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '');
    const token = bearer || c.req.header('x-access-token') || '';
    if (!safeEqual(token, config.accessToken)) return c.json({ error: 'Unauthorized', code: 'unauthorized' }, 401);
  }
  return next();
});

// Tiny per-IP limiter on state-changing routes (the app can spend real email quota)
const hits = new Map();
app.use('/api/*', async (c, next) => {
  if (c.req.method === 'GET') return next();
  const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0].trim() || 'local';
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  if (arr.length >= 60) return c.json({ error: 'Too many requests, slow down', code: 'rate_limited' }, 429, { 'Retry-After': '30' });
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < 60_000)) hits.delete(k);
  return next();
});

/* --------------------------------------------------------------- utilities */
const providerView = (p, used) => {
  const att = p.attachments();
  return {
    id: p.id,
    label: p.label,
    kind: p.kind,
    configured: p.missing().length === 0,
    missing: p.missing(),
    rps: p.rps,
    quota: p.quota ? { limit: p.quota.limit, period: p.quota.period, used: used[p.id] || 0 } : null,
    attachments: att.supported ? { supported: true, maxKB: Number.isFinite(att.maxBytes) ? Math.round(att.maxBytes / 1024) : null } : { supported: false, reason: att.reason },
  };
};

function redisView() {
  const r = config.redis;
  const c = getClient();
  return {
    configured: !!r,
    status: !r ? 'off' : redisReady() ? 'ready' : c?.status || 'connecting',
    host: r ? maskHost(r.host) : null,
    tls: r?.tls ?? false,
    upstash: r?.isUpstash ?? false,
    note: r?.upgraded ? 'redis:// was upgraded to TLS because Upstash requires it' : null,
    error: config.redisError,
  };
}

/* ------------------------------------------------------------------ routes */
app.get('/api/health', (c) => c.json({ ok: true, uptime: Math.round(process.uptime()), env: config.env }));

app.get('/api/status', async (c) => {
  const providers = enabledProviders();
  const redis = redisView();
  const [metrics, used, log] = await Promise.all([store.getMetrics(), store.getQuotaUsed(providers), store.getLog(40)]);

  let queues = null;
  let paused = false;
  let workers = [];
  if (redis.status === 'ready') {
    try {
      const live = readyProviders();
      [queues, paused, workers] = await Promise.all([queue.allQueueCounts(live), queue.isPaused(), store.getWorkers()]);
    } catch (e) {
      redis.error = `Queue read failed: ${e.message}`;
    }
  }
  const inflight = directInflight();
  return c.json({
    now: Date.now(),
    env: config.env,
    auth: { required: !!config.accessToken },
    redis,
    queueAvailable: redis.status === 'ready',
    paused,
    workers,
    providers: providers.map((p) => providerView(p, used)),
    direct: Object.fromEntries(providers.map((p) => [p.id, { inflight: inflight[p.id] || 0 }])),
    queues, // { providerId: { waiting, delayed, active } }
    metrics,
    limits: { burstReal: config.burstMaxReal, burstSim: config.burstMaxSim, attachmentKB: Math.round(config.maxAttachmentBytes / 1024), simulator: config.simulatorEnabled },
    log,
  });
});

app.post('/api/send', bodyLimit({ maxSize: maxBody, onError: (c) => c.json({ error: `Request too large (limit ${Math.round(maxBody / 1024)} KB)`, code: 'too_large' }, 413) }), async (c) => {
  let raw;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }
  const { email, mode, pool, count, warnings } = parseSendBody(raw);

  if (mode === 'queued') {
    if (redisView().status !== 'ready') throw new HttpError(503, 'Queue is unavailable: Redis is not connected. Use Direct mode or fix REDIS_URL.');
    const r = await queue.enqueue({ email, pool, count });
    const label = summarize(Object.entries(r.distribution).flatMap(([id, n]) => Array(n).fill(id)), pool);
    return c.json({ mode, ...r, summary: label, warnings, workerHint: (await store.getWorkers()).length ? null : 'No worker heartbeat seen: jobs will wait until a worker starts (npm run worker).' }, 202);
  }

  const results = await runDirect({ email, pool, count });
  const sent = results.filter((r) => r.ok).length;
  return c.json({ mode, requested: count, sent, failed: results.length - sent, results, warnings }, sent ? 200 : 502);
});

app.post('/api/queue/pause', async (c) => (await queue.setPaused(true), c.json({ paused: true })));
app.post('/api/queue/resume', async (c) => (await queue.setPaused(false), c.json({ paused: false })));
app.post('/api/queue/clear', async (c) => c.json({ removed: await queue.clearQueues() }));
app.post('/api/reset', async (c) => (await store.resetCounters(), c.json({ ok: true })));
app.post('/api/log/clear', async (c) => (await store.clearLog(), c.json({ ok: true })));

app.post('/api/diagnostics', async (c) => {
  const checks = [];
  const add = (name, ok, detail, ms) => checks.push({ name, ok, detail, ms });

  // Redis
  if (config.redisError) add('Redis config', false, config.redisError);
  else if (!config.redis) add('Redis config', false, 'REDIS_URL not set: queued mode disabled');
  else {
    const t0 = Date.now();
    try {
      const pong = await getClient().ping();
      const ms = Date.now() - t0;
      const info = await getClient().info('server').catch(() => '');
      const ver = /redis_version:([\d.]+)/.exec(info)?.[1];
      add('Redis connection', pong === 'PONG', `PONG over ${config.redis.tls ? 'TLS' : 'plain TCP'}${ver ? `, Redis ${ver}` : ''}`, ms);
      let policy = null;
      try {
        policy = (await getClient().config('GET', 'maxmemory-policy'))?.[1];
      } catch {
        /* managed Redis (Upstash) hides CONFIG */
      }
      if (policy) add('Eviction policy', policy === 'noeviction', policy === 'noeviction' ? 'noeviction (required by BullMQ)' : `${policy}: BullMQ can lose jobs, use noeviction`);
    } catch (e) {
      add('Redis connection', false, e.message);
    }
  }
  const wk = await store.getWorkers().catch(() => []);
  add('Queue workers', wk.length > 0, wk.length ? `${wk.length} worker process(es) alive` : 'no worker heartbeat: start with npm start or npm run worker');

  // Providers
  for (const p of enabledProviders().filter((x) => x.kind === 'live')) {
    const miss = p.missing();
    if (miss.length) {
      add(`${p.label} credentials`, false, `missing ${miss.join(', ')}`);
      continue;
    }
    if (typeof p.check === 'function') {
      const t0 = Date.now();
      try {
        const r = await p.check();
        add(`${p.label} credentials`, r.ok, r.detail, Date.now() - t0);
      } catch (e) {
        add(`${p.label} credentials`, false, e.message);
      }
    } else {
      add(`${p.label} credentials`, true, 'configured (EmailJS has no free verification call, send a test email to confirm)');
    }
  }
  return c.json({ checks, ok: checks.every((x) => x.ok) });
});

/* ------------------------------------------------------------ errors/static */
app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message, field: err.field, code: 'bad_request' }, err.status);
  console.error('[api]', err);
  return c.json({ error: config.isProd ? 'Internal error' : err.message, code: 'internal' }, 500);
});

app.use('/*', serveStatic({ root: './public' }));
app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'Not found' }, 404) : c.text('Not found', 404)));
