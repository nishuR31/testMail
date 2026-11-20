import { serve } from '@hono/node-server';
import { app } from './app.js';
import { config } from './config.js';
import { closeClient, getClient } from './redis.js';
import { closeQueues, startWorkers } from './queue.js';
import { enabledProviders, readyProviders } from './providers/index.js';
import { maskHost } from './util.js';

const live = enabledProviders().filter((p) => p.kind === 'live');
console.log(`\n  Mailbench  [${config.env}]`);
console.log(`  redis      ${config.redisError ? `ERROR: ${config.redisError}` : config.redis ? `${maskHost(config.redis.host)}:${config.redis.port} ${config.redis.tls ? '(TLS)' : '(no TLS)'}${config.redis.upgraded ? ' [upgraded to TLS]' : ''}` : 'not configured (queued mode disabled)'}`);
for (const p of live) console.log(`  ${p.label.padEnd(10)} ${p.missing().length ? `not configured (${p.missing().join(', ')})` : 'ready'}`);
console.log(`  simulators ${config.simulatorEnabled ? 'on' : 'off'}`);
if (config.isProd && !config.accessToken) console.warn('  WARNING: ACCESS_TOKEN is not set, /api is locked (503) until you set it.');
if (!config.isProd && !config.accessToken) console.warn('  note: no ACCESS_TOKEN set (fine for localhost, required in production).');
if (!readyProviders().length) console.warn('  no provider is ready, nothing can be sent.');

if (config.redis) getClient(); // connect eagerly so /api/status reflects reality

let workers = null;
if (config.redis && config.runWorker) {
  workers = await startWorkers().catch((e) => {
    console.error('[worker] failed to start:', e.message);
    return null;
  });
}

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (i) => console.log(`  listening  http://${i.address === '0.0.0.0' ? 'localhost' : i.address}:${i.port}\n`));

let closing = false;
async function shutdown(sig) {
  if (closing) return;
  closing = true;
  console.log(`\n${sig} received, shutting down...`);
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  server.close();
  await workers?.stop().catch(() => {});
  await closeQueues().catch(() => {});
  await closeClient().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.message || e));
