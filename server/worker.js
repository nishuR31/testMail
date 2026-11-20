// Standalone worker process: `npm run worker`. Run this on a separate dyno/container in production
// and set RUN_WORKER=false on the web process if you want them split.
import { config } from './config.js';
import { closeClient, getClient } from './redis.js';
import { closeQueues, startWorkers } from './queue.js';

if (!config.redis) {
  console.error(config.redisError || 'REDIS_URL is not set, a worker has nothing to consume.');
  process.exit(1);
}
getClient();
const workers = await startWorkers();
if (!workers.providers.length) {
  console.error('No provider is configured, exiting.');
  process.exit(1);
}
const stop = async (sig) => {
  console.log(`${sig}: draining worker...`);
  await workers.stop().catch(() => {});
  await closeQueues().catch(() => {});
  await closeClient().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
