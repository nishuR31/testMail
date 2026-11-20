// Queued mode, built on BullMQ.
//
//   one queue + one worker per provider   -> each provider gets its own rate limit (limiter) and its own backlog
//   enqueue-time load balancing           -> the next email is fed to the provider with the shortest estimated wait
//   429 from a provider                   -> queue is rate-limited for retry-after, job goes back without using an attempt
//   transient failure                     -> exponential back-off, up to QUEUE_ATTEMPTS
//   permanent failure / quota / exhausted -> failover: the job is re-fed to another selected provider's queue
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { Queue, Worker, UnrecoverableError } from "bullmq";
import { config } from './config.js';
import { toProviderError } from './errors.js';
import { plan } from './balancer.js';
import { enabledProviders, providerById, readyProviders } from './providers/index.js';
import { getClient, onRedisError, redisOptions, redisReady } from './redis.js';
import { Redis } from 'ioredis';
import { HEARTBEAT_EVERY_MS, getQuotaUsed, heartbeat, incrMetric, incrQuota, pushLog, removeHeartbeat } from './store.js';
import { describeEmail } from './validate.js';
import { safe } from './util.js';

const MAX_RATE_LIMIT_HOPS = 20;
const queueName = (id) => `mail-${id}`;
export const INSTANCE_ID = `${hostname().slice(0, 12)}-${process.pid}-${randomUUID().slice(0, 4)}`;

/* ------------------------------------------------------------------ queues */
const queues = new Map();

export function getQueue(providerId) {
  if (!queues.has(providerId)) {
    const q = new Queue(queueName(providerId), {
      connection: getClient(),
      prefix: config.queue.prefix,
      skipVersionCheck: true,
      defaultJobOptions: {
        attempts: config.queue.attempts,
        backoff: { type: 'exponential', delay: config.queue.backoffMs, jitter: 0.25 },
        removeOnComplete: { age: 3600, count: 100 },
        removeOnFail: { age: 86400, count: 200 },
      },
    });
    q.on('error', onRedisError(`queue:${providerId}`));
    queues.set(providerId, q);
  }
  return queues.get(providerId);
}

export const queueAvailable = () => !!config.redis && enabledProviders().length > 0;

/** waiting + delayed + paused (not yet started) and active (in flight) for one provider. */
export async function queueCounts(providerId) {
  const c = await getQueue(providerId).getJobCounts('waiting', 'delayed', 'paused', 'active');
  const waiting = (c.waiting || 0) + (c.paused || 0);
  return { waiting, delayed: c.delayed || 0, active: c.active || 0 };
}

export async function allQueueCounts(providers) {
  const rows = await Promise.all(providers.map(async (p) => [p.id, await queueCounts(p.id)]));
  return Object.fromEntries(rows);
}

const backlog = (c) => c.waiting + c.delayed + c.active;

export async function isPaused() {
  const first = readyProviders()[0];
  return first ? getQueue(first.id).isPaused() : false;
}
export async function setPaused(paused) {
  await Promise.all(readyProviders().map((p) => (paused ? getQueue(p.id).pause() : getQueue(p.id).resume())));
}
export async function clearQueues() {
  let removed = 0;
  for (const p of readyProviders()) {
    const q = getQueue(p.id);
    const before = await queueCounts(p.id);
    await q.drain(true); // waiting + delayed; active jobs are left to finish
    removed += before.waiting + before.delayed;
  }
  return removed;
}

/* ----------------------------------------------------------------- enqueue */
function remainingQuota(pool, used, pending) {
  const out = {};
  if (!config.enforceQuota) return out;
  for (const p of pool) if (p.quota) out[p.id] = Math.max(0, p.quota.limit - (used[p.id] || 0) - (pending[p.id] || 0));
  return out;
}

export async function enqueue({ email, pool, count }) {
  const [counts, used] = await Promise.all([allQueueCounts(pool), getQuotaUsed(pool)]);
  const pending = Object.fromEntries(pool.map((p) => [p.id, backlog(counts[p.id])]));
  const { assignments, unassigned } = plan(count, pool, pending, remainingQuota(pool, used, pending));

  const batchId = randomUUID().slice(0, 8);
  const poolIds = pool.map((p) => p.id);
  const byProvider = {};
  assignments.forEach((id, i) => {
    (byProvider[id] ??= []).push({
      name: 'send',
      data: {
        batchId,
        idx: i + 1,
        total: count,
        pool: poolIds,
        tried: [],
        hops: 0,
        enqueuedAt: Date.now(),
        email: count > 1 ? { ...email, subject: `${email.subject} (#${i + 1}/${count})` } : email,
      },
      opts: { jobId: `${batchId}_${i + 1}` },
    });
  });
  await Promise.all(Object.entries(byProvider).map(([id, jobs]) => getQueue(id).addBulk(jobs)));

  const distribution = Object.fromEntries(Object.entries(byProvider).map(([id, jobs]) => [id, jobs.length]));
  await Promise.all(Object.entries(distribution).map(([id, n]) => incrMetric('queued', id, 'enqueued', n)));
  await safe(() =>
    pushLog({
      mode: 'queued',
      status: 'queued',
      provider: Object.keys(distribution).length === 1 ? Object.keys(distribution)[0] : 'balanced',
      detail: `${assignments.length} email(s) -> ${Object.entries(distribution).map(([id, n]) => `${providerById(id)?.label ?? id} x${n}`).join(', ')}`,
      to: email.to,
      subject: email.subject,
    })
  );
  return { batchId, accepted: assignments.length, unassigned, distribution };
}

/* ---------------------------------------------------------------- failover */
async function failover(job, reason) {
  const { pool, tried = [], hops = 0 } = job.data;
  const here = job.queueName.replace(/^mail-/, '');
  const candidates = pool.filter((id) => id !== here && !tried.includes(id)).map(providerById).filter((p) => p && p.missing().length === 0);
  if (!candidates.length || hops >= 4) return null;
  if (job.data.email.attachment) {
    const ok = candidates.filter((p) => {
      const cap = p.attachments();
      return cap.supported && job.data.email.attachment.bytes <= cap.maxBytes;
    });
    if (!ok.length) return null;
    candidates.length = 0;
    candidates.push(...ok);
  }
  const [counts, used] = await Promise.all([allQueueCounts(candidates), getQuotaUsed(candidates)]);
  const pending = Object.fromEntries(candidates.map((p) => [p.id, backlog(counts[p.id])]));
  const { assignments } = plan(1, candidates, pending, remainingQuota(candidates, used, pending));
  const target = assignments[0];
  if (!target) return null;
  const base = job.id.replace(/_f\d+$/, '');
  await getQueue(target).add(
    'send',
    { ...job.data, tried: [...tried, here], hops: hops + 1, hopReason: reason },
    { jobId: `${base}_f${hops + 1}` }
  );
  await incrMetric('queued', target, 'enqueued', 1);
  return target;
}

/* --------------------------------------------------------------- processor */
function makeProcessor(provider) {
  return async function process(job) {
    const { email, tried = [] } = job.data;
    const started = Date.now();
    const waitedMs = Math.max(0, started - (job.data.enqueuedAt || job.timestamp));
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts || 1);
    const meta = describeEmail(email);

    // Free-tier guard: never burn calls past the quota
    if (provider.quota && config.enforceQuota) {
      const used = (await getQuotaUsed([provider]))[provider.id] || 0;
      if (used >= provider.quota.limit) {
        const to = await failover(job, 'quota');
        await incrMetric('queued', provider.id, to ? 'failover' : 'failed');
        await safe(() => pushLog({ mode: 'queued', provider: provider.id, status: to ? 'failover' : 'failed', kind: 'quota', error: `${provider.label} free-tier quota reached`, to: meta.to, subject: meta.subject, target: to || undefined }));
        if (to) return { failedOver: to };
        throw new UnrecoverableError(`${provider.label} free-tier quota reached`);
      }
    }

    try {
      const out = await provider.send(email, { idempotencyKey: `mb-${job.id}` });
      const ms = Date.now() - started;
      // Bookkeeping must never turn a delivered email into a retry
      await safe(() =>
        Promise.all([
          incrQuota(provider),
          incrMetric('queued', provider.id, 'sent'),
          incrMetric('queued', provider.id, 'ms', ms),
          incrMetric('queued', provider.id, 'waitms', waitedMs),
          pushLog({ mode: 'queued', provider: provider.id, status: 'sent', ms, waitedMs, attempt: job.attemptsMade + 1, ...meta, msgId: out.id || undefined, rescued: tried.length ? tried[0] : undefined }),
        ])
      );
      return { id: out.id, ms };
    } catch (err) {
      const e = toProviderError(err);

      // Provider says "slow down": pause this queue and give the job back without spending an attempt
      if (e.kind === 'rate_limit') {
        const hops = (job.data.rl || 0) + 1;
        if (hops <= MAX_RATE_LIMIT_HOPS) {
          const ms = Math.min(Math.max(e.retryAfterMs ?? 1000, 250), 30_000);
          await safe(async () => {
            await getQueue(provider.id).rateLimit(ms);
            await job.updateData({ ...job.data, rl: hops });
            await incrMetric('queued', provider.id, 'throttled');
          });
          throw Worker.RateLimitError();
        }
      }

      const permanent = !e.retryable || e.kind === 'rate_limit';
      if (permanent || finalAttempt) {
        const to = await failover(job, e.kind);
        await safe(() =>
          Promise.all([
            incrMetric('queued', provider.id, to ? 'failover' : 'failed'),
            pushLog({ mode: 'queued', provider: provider.id, status: to ? 'failover' : 'failed', kind: e.kind, error: e.message, attempt: job.attemptsMade + 1, ...meta, target: to || undefined }),
          ])
        );
        if (to) return { failedOver: to };
        throw new UnrecoverableError(e.message);
      }

      await safe(() =>
        Promise.all([
          incrMetric('queued', provider.id, 'retried'),
          pushLog({ mode: 'queued', provider: provider.id, status: 'retry', kind: e.kind, error: e.message, attempt: job.attemptsMade + 1, ...meta }),
        ])
      );
      throw err instanceof Error ? err : new Error(e.message); // BullMQ schedules the exponential back-off
    }
  };
}

/* ----------------------------------------------------------------- workers */
function limiterFor(rps) {
  const r = Math.max(rps, 0.05);
  // Fixed-window limiter. A small safety margin keeps us just under the provider's real limit.
  return r >= 1 ? { max: Math.max(1, Math.floor(r)), duration: 1100 } : { max: 1, duration: Math.ceil((1000 / r) * 1.1) };
}

export async function startWorkers() {
  if (!config.redis) return { stop: async () => {}, providers: [] };
  const providers = readyProviders();
  const connection = new Redis(redisOptions({ blocking: true }));
  connection.on('error', onRedisError('worker'));

  const workers = providers.map((p) => {
    const w = new Worker(queueName(p.id), makeProcessor(p), {
      connection,
      prefix: config.queue.prefix,
      skipVersionCheck: true,
      concurrency: Math.max(1, Math.ceil(p.rps)),
      limiter: limiterFor(p.rps),
      drainDelay: config.queue.drainDelaySec,
      stalledInterval: config.queue.stalledIntervalMs,
      lockDuration: config.queue.lockDurationMs,
      maxStalledCount: 1,
    });
    w.on('error', onRedisError(`worker:${p.id}`));
    w.on('stalled', (id) => console.warn(`[worker:${p.id}] job ${id} stalled`));
    w.on('failed', (job, err) => {
      if (!(err instanceof UnrecoverableError) && job && job.attemptsMade >= (job.opts.attempts || 1)) console.warn(`[worker:${p.id}] job ${job.id} failed: ${err.message}`);
    });
    return w;
  });

  const beat = () =>
    safe(
      () => heartbeat(INSTANCE_ID, { pid: process.pid, host: hostname(), providers: providers.map((p) => p.id), startedAt, role: config.runWorker ? 'web+worker' : 'worker' }),
      'heartbeat'
    );
  const startedAt = Date.now();
  await beat();
  const timer = setInterval(beat, HEARTBEAT_EVERY_MS);
  timer.unref();

  console.log(`[worker] ${INSTANCE_ID} consuming: ${providers.map((p) => `${p.id}(${limiterFor(p.rps).max}/${limiterFor(p.rps).duration}ms)`).join(', ') || 'nothing (no provider configured)'}`);

  return {
    providers: providers.map((p) => p.id),
    async stop() {
      clearInterval(timer);
      await Promise.allSettled(workers.map((w) => w.close()));
      await safe(() => removeHeartbeat(INSTANCE_ID), 'heartbeat');
      connection.disconnect();
    },
  };
}

export async function closeQueues() {
  await Promise.allSettled([...queues.values()].map((q) => q.close()));
  queues.clear();
}

export { redisReady };
