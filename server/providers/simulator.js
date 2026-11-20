// Free local stand-ins for real providers. They enforce a per-second rate limit and can inject failures, so queue
// behaviour (throttling, retries, load balancing) can be tested without burning free-tier quota.
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { ProviderError } from '../errors.js';
import { sleep } from '../util.js';

const WINDOW_MS = 850; // a bit under 1s: the queue limiter and this window run on different clocks

function makeSim(id, label, cfg) {
  const hits = [];
  const cap = Math.max(1, Math.round(cfg.rps));
  return {
    id,
    label,
    kind: 'sim',
    rps: cfg.rps,
    quota: null,
    missing: () => [],
    attachments: () => ({ supported: true, maxBytes: Infinity }),

    async send(email) {
      const now = Date.now();
      while (hits.length && now - hits[0] >= WINDOW_MS) hits.shift();
      if (hits.length >= cap) {
        throw new ProviderError(`${label}: rate limit exceeded (${cfg.rps} req/s)`, {
          kind: 'rate_limit',
          status: 429,
          retryAfterMs: Math.max(100, WINDOW_MS - (now - hits[0])),
        });
      }
      hits.push(now);
      await sleep(cfg.latencyMs * (0.7 + Math.random() * 0.6));
      const failRate = email.simFailRate ?? config.providers.simFailRate;
      if (Math.random() < failRate) throw new ProviderError(`${label}: simulated upstream 503`, { kind: 'server', status: 503 });
      return { id: `sim_${randomUUID().slice(0, 8)}` };
    },
  };
}

export const simfast = makeSim('simfast', 'Sim Fast', config.providers.simfast);
export const simslow = makeSim('simslow', 'Sim Slow', config.providers.simslow);
