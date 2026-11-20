// Central configuration. Everything comes from environment variables (see .env.example).
import { existsSync } from 'node:fs';

// Node >= 21.7 can load .env natively. Real env vars always win over the file.
try {
  if (existsSync('.env')) process.loadEnvFile('.env');
} catch {
  /* ignore malformed .env, validation below reports what is missing */
}

const env = process.env;
const clean = (v) => (v ?? '').toString().trim().replace(/^['"]|['"]$/g, '');
const bool = (v, d) => (clean(v) === '' ? d : /^(1|true|yes|on)$/i.test(clean(v)));
const int = (v, d) => {
  const n = parseInt(clean(v), 10);
  return Number.isFinite(n) ? n : d;
};
const float = (v, d) => {
  const n = parseFloat(clean(v));
  return Number.isFinite(n) ? n : d;
};
const list = (v) =>
  clean(v)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

/**
 * Normalise whatever the user pasted from the Upstash console into connection settings.
 *
 * BullMQ talks to Redis over TCP, so it needs the *Redis protocol* endpoint
 * (rediss://default:<password>@<name>.upstash.io:6379) and NOT the REST url/token pair.
 * Accepted inputs:
 *   - rediss://default:pw@host:6379        (correct)
 *   - redis://default:pw@host:6379         (upstash host => upgraded to TLS automatically)
 *   - redis-cli --tls -u redis://...       (the snippet shown in the console)
 *   - REDIS_HOST / REDIS_PORT / REDIS_PASSWORD (+ REDIS_TLS) discrete variables
 */
export function parseRedisUrl(raw, discrete = {}) {
  let input = clean(raw);
  if (!input && discrete.host) {
    const proto = discrete.tls ? 'rediss' : 'redis';
    const user = encodeURIComponent(discrete.username || 'default');
    const pw = discrete.password ? `:${encodeURIComponent(discrete.password)}` : '';
    input = `${proto}://${discrete.password ? user : ''}${pw}${discrete.password ? '@' : ''}${discrete.host}:${discrete.port || 6379}`;
  }
  if (!input) return null;

  const cliMatch = input.match(/(rediss?:\/\/[^\s'"]+)/i);
  if (cliMatch) input = cliMatch[1];
  if (/^https?:\/\//i.test(input)) {
    throw new Error(
      'REDIS_URL is an https:// (Upstash REST) address. BullMQ needs the TCP endpoint: ' +
        'rediss://default:<password>@<name>.upstash.io:6379 (Upstash console > Redis > "Connect" > ioredis).'
    );
  }
  if (!/^rediss?:\/\//i.test(input)) {
    if (/^[\w.-]+:\d+$/.test(input)) input = `redis://${input}`;
    else throw new Error('REDIS_URL must start with redis:// or rediss://');
  }

  let u;
  try {
    u = new URL(input);
  } catch {
    throw new Error('REDIS_URL is not a valid URL (special characters in the password must be percent-encoded)');
  }
  const host = u.hostname;
  const isUpstash = /\.upstash\.io$/i.test(host);
  let tls = u.protocol === 'rediss:' || bool(discrete.tls, false);
  let upgraded = false;
  if (isUpstash && !tls) {
    tls = true; // Upstash only accepts TLS connections
    upgraded = true;
  }
  return {
    host,
    port: u.port ? parseInt(u.port, 10) : 6379,
    username: decodeURIComponent(u.username || '') || undefined,
    password: decodeURIComponent(u.password || '') || undefined,
    db: u.pathname && u.pathname.length > 1 ? parseInt(u.pathname.slice(1), 10) || 0 : 0,
    tls,
    isUpstash,
    upgraded,
  };
}

const isProd = clean(env.NODE_ENV) === 'production';

// Upstash console also hands out UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN. The REST token is the same
// secret as the TCP password and the host is shared, so we can derive the TCP endpoint from it as a last resort.
function upstashFromRest() {
  const url = clean(env.UPSTASH_REDIS_REST_URL);
  const token = clean(env.UPSTASH_REDIS_REST_TOKEN);
  if (!url || !token) return '';
  try {
    const host = new URL(url).hostname;
    return `rediss://default:${encodeURIComponent(token)}@${host}:6379`;
  } catch {
    return '';
  }
}

let redis = null;
let redisError = null;
try {
  redis = parseRedisUrl(env.REDIS_URL || env.UPSTASH_REDIS_URL || upstashFromRest(), {
    host: clean(env.REDIS_HOST),
    port: int(env.REDIS_PORT, 6379),
    username: clean(env.REDIS_USERNAME),
    password: clean(env.REDIS_PASSWORD),
    tls: clean(env.REDIS_TLS),
  });
} catch (e) {
  redisError = e.message;
}

export const config = {
  env: clean(env.NODE_ENV) || 'development',
  isProd,
  host: clean(env.HOST) || '0.0.0.0',
  port: int(env.PORT, 3000),

  // Protects every /api route. STRONGLY recommended outside localhost: this app sends real email.
  accessToken: clean(env.ACCESS_TOKEN),
  // Optional allow-list: full addresses or domains, e.g. "me@gmail.com,example.com"
  allowedRecipients: list(env.ALLOWED_RECIPIENTS),

  runWorker: bool(env.RUN_WORKER, true),
  simulatorEnabled: bool(env.ENABLE_SIMULATOR, !isProd),

  // Upstash free tier caps a single request at ~1MB, and attachments travel inside the job (base64 = +33%).
  maxAttachmentBytes: int(env.ATTACHMENT_MAX_KB, 512) * 1024,
  burstMaxReal: int(env.BURST_MAX_REAL, 10),
  burstMaxSim: int(env.BURST_MAX_SIM, 100),
  enforceQuota: bool(env.ENFORCE_QUOTA, true),

  redis,
  redisError,

  queue: {
    prefix: clean(env.QUEUE_PREFIX) || `etq-${isProd ? 'prod' : 'dev'}`,
    attempts: Math.max(1, int(env.QUEUE_ATTEMPTS, 3)),
    backoffMs: int(env.QUEUE_BACKOFF_MS, 2000),
    // Upstash bills per command. Idle workers long-poll with BZPOPMIN every `drainDelay` seconds.
    drainDelaySec: Math.max(1, int(env.QUEUE_DRAIN_DELAY_S, 30)),
    stalledIntervalMs: int(env.QUEUE_STALLED_INTERVAL_MS, 120000),
    lockDurationMs: int(env.QUEUE_LOCK_DURATION_MS, 60000),
  },

  providers: {
    emailjs: {
      serviceId: clean(env.EMAILJS_SERVICE_ID),
      templateId: clean(env.EMAILJS_TEMPLATE_ID),
      publicKey: clean(env.EMAILJS_PUBLIC_KEY),
      privateKey: clean(env.EMAILJS_PRIVATE_KEY),
      // Name of the "Variable attachment" parameter configured in the template (paid EmailJS feature).
      attachmentParam: clean(env.EMAILJS_ATTACHMENT_PARAM),
      fromName: clean(env.EMAILJS_FROM_NAME) || 'Email Test Suite',
      rps: float(env.EMAILJS_RPS, 1), // EmailJS REST API: 1 request / second
      limit: int(env.EMAILJS_MONTHLY_LIMIT, 200), // free tier
      maxAttachmentBytes: int(env.EMAILJS_ATTACHMENT_MAX_KB, 50) * 1024,
    },
    resend: {
      apiKey: clean(env.RESEND_API_KEY),
      from: clean(env.RESEND_FROM) || 'Email Test Suite <onboarding@resend.dev>',
      rps: float(env.RESEND_RPS, 2), // Resend default: 2 requests / second
      limit: int(env.RESEND_DAILY_LIMIT, 100), // free tier
    },
    // Two simulated lanes with different speeds so load balancing is visible without spending free-tier quota.
    simfast: {
      rps: float(env.SIM_FAST_RPS, 2),
      latencyMs: int(env.SIM_FAST_LATENCY_MS, 350),
    },
    simslow: {
      rps: float(env.SIM_SLOW_RPS, 1),
      latencyMs: int(env.SIM_SLOW_LATENCY_MS, 900),
    },
    simFailRate: Math.min(1, Math.max(0, float(env.SIM_FAIL_RATE, 0))),
  },
};
