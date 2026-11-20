// Boots the real app against in-memory state (no Redis) and exercises validation, auth and direct mode.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.REDIS_URL = '';
process.env.UPSTASH_REDIS_REST_URL = '';
// Isolate from a developer's real .env: this suite asserts providers are unconfigured.
process.env.RESEND_API_KEY = '';
process.env.EMAILJS_SERVICE_ID = '';
process.env.EMAILJS_TEMPLATE_ID = '';
process.env.EMAILJS_PUBLIC_KEY = '';
process.env.EMAILJS_PRIVATE_KEY = '';
process.env.ENABLE_SIMULATOR = 'true';
process.env.ACCESS_TOKEN = 'secret-token';
process.env.SIM_FAST_LATENCY_MS = '5';
process.env.SIM_SLOW_LATENCY_MS = '5';
process.env.SIM_FAST_RPS = '50';
process.env.SIM_SLOW_RPS = '50';

let app;
before(async () => {
  ({ app } = await import('../server/app.js'));
});

const auth = { Authorization: 'Bearer secret-token', 'Content-Type': 'application/json' };
const post = (body, headers = auth) => app.request('/api/send', { method: 'POST', headers, body: JSON.stringify(body) });
const base = { to: 'a@b.co', subject: 's', message: 'm', mode: 'direct', providers: ['simfast'] };

test('health is public, everything else needs the token', async () => {
  assert.equal((await app.request('/api/health')).status, 200);
  assert.equal((await app.request('/api/status')).status, 401);
  assert.equal((await app.request('/api/status', { headers: { Authorization: 'Bearer nope' } })).status, 401);
  assert.equal((await app.request('/api/status', { headers: auth })).status, 200);
});

test('security headers are set', async () => {
  const r = await app.request('/api/health');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
});

test('validation rejects bad input with a field name', async () => {
  const cases = [
    [{ ...base, to: 'nope' }, 'to'],
    [{ ...base, subject: '   ' }, 'subject'],
    [{ ...base, subject: 'a\nb' }, 'subject'],
    [{ ...base, message: '' }, 'message'],
    [{ ...base, mode: 'x' }, 'mode'],
    [{ ...base, providers: [] }, 'providers'],
    [{ ...base, providers: ['bogus'] }, 'providers'],
    [{ ...base, providers: ['resend'] }, 'providers'], // not configured
    [{ ...base, count: 0 }, 'count'],
    [{ ...base, count: 9999 }, 'count'],
    [{ ...base, attachment: { filename: 'x.txt', content: '***' } }, 'attachment'],
  ];
  for (const [body, field] of cases) {
    const r = await post(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal((await r.json()).field, field);
  }
});

test('invalid JSON is a 400, not a 500', async () => {
  const r = await app.request('/api/send', { method: 'POST', headers: auth, body: '{oops' });
  assert.equal(r.status, 400);
});

test('direct mode sends and updates counters', async () => {
  const r = await post({ ...base, count: 3, providers: ['simfast', 'simslow'] });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.sent, 3);
  const s = await (await app.request('/api/status', { headers: auth })).json();
  const total = Object.values(s.metrics.direct).reduce((a, x) => a + (x.sent || 0), 0);
  assert.equal(total, 3);
  assert.equal(s.queueAvailable, false);
});

test('queued mode without Redis is refused cleanly', async () => {
  const r = await post({ ...base, mode: 'queued' });
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /Redis/);
});

test('attachment is accepted (base64) by providers that support it', async () => {
  const content = Buffer.from('hello').toString('base64');
  const r = await post({ ...base, attachment: { filename: 'a/b?.txt', content, contentType: 'text/plain' } });
  assert.equal(r.status, 200);
});

test('oversized attachment is rejected with 413', async () => {
  const content = Buffer.alloc(600 * 1024).toString('base64');
  const r = await post({ ...base, attachment: { filename: 'big.bin', content } });
  assert.equal(r.status, 413);
});

test('simulated failures surface as a 502 with per-email results', async () => {
  const r = await post({ ...base, count: 2, simFailRate: 1 });
  assert.equal(r.status, 502);
  const j = await r.json();
  assert.equal(j.failed, 2);
  assert.ok(j.results.every((x) => x.kind === 'server'));
});
