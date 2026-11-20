// "Direct" mode: the request calls the provider immediately. No queue, no throttling, no retries, no failover.
// That is deliberate, it is the baseline the queued mode is compared against.
import { config } from './config.js';
import { toProviderError } from './errors.js';
import { plan } from './balancer.js';
import { describeEmail } from './validate.js';
import { getQuotaUsed, incrMetric, incrQuota, pushLog } from './store.js';
import { safe } from './util.js';

const inflight = {};
export const directInflight = () => ({ ...inflight });

async function sendOne(provider, email) {
  inflight[provider.id] = (inflight[provider.id] || 0) + 1;
  const t0 = Date.now();
  try {
    const out = await provider.send(email);
    const ms = Date.now() - t0;
    await safe(() =>
      Promise.all([
        incrQuota(provider),
        incrMetric('direct', provider.id, 'sent'),
        incrMetric('direct', provider.id, 'ms', ms),
        pushLog({ mode: 'direct', provider: provider.id, status: 'sent', ms, ...describeEmail(email), msgId: out.id || undefined }),
      ])
    );
    return { ok: true, provider: provider.id, ms, id: out.id };
  } catch (err) {
    const e = toProviderError(err);
    const ms = Date.now() - t0;
    await safe(() =>
      Promise.all([
        incrMetric('direct', provider.id, e.kind === 'rate_limit' ? 'throttled' : 'failed'),
        pushLog({ mode: 'direct', provider: provider.id, status: 'failed', kind: e.kind, ms, error: e.message, ...describeEmail(email) }),
      ])
    );
    return { ok: false, provider: provider.id, ms, error: e.message, kind: e.kind };
  } finally {
    inflight[provider.id] -= 1;
  }
}

export async function runDirect({ email, pool, count }) {
  const used = await getQuotaUsed(pool);
  const remaining = {};
  for (const p of pool) if (p.quota && config.enforceQuota) remaining[p.id] = Math.max(0, p.quota.limit - (used[p.id] || 0) - (inflight[p.id] || 0));

  const { assignments, unassigned } = plan(count, pool, inflight, remaining);
  const byId = Object.fromEntries(pool.map((p) => [p.id, p]));
  const results = await Promise.all(
    assignments.map((id, i) => sendOne(byId[id], count > 1 ? { ...email, subject: `${email.subject} (#${i + 1}/${count})` } : email))
  );
  for (let i = 0; i < unassigned; i++) {
    results.push({ ok: false, provider: null, ms: 0, kind: 'quota', error: 'Free-tier quota exhausted for all selected providers' });
  }
  return results;
}
