import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config, parseRedisUrl } from '../server/config.js';
import { buildTemplateParams } from '../server/providers/emailjs.js';
import { plan } from '../server/balancer.js';
import { periodKey } from '../server/store.js';
import { renderHtmlEmail } from '../server/providers/html-template.js';

/* ---- hardcoded HTML template ---------------------------------------------------------------- */
test('EmailJS params cover template_v3ixl79 variables', () => {
  const p = buildTemplateParams({ to: 'a@b.co', subject: 's', message: 'm' });
  assert.equal(p.email, 'a@b.co');
  assert.equal(p.to_email, 'a@b.co');
  assert.equal(p.name, config.providers.emailjs.fromName);
  assert.equal(p.subject, 's');
  assert.equal(p.message, 'm');
  assert.ok(p.time);
});

test('hardcoded HTML template escapes input and keeps line breaks', () => {
  const html = renderHtmlEmail({ subject: 'Hi <b>', message: 'a <script> & \nb', fromName: 'Me & Co' });
  assert.match(html, /Hi &lt;b&gt;/);
  assert.match(html, /a &lt;script&gt; &amp; <br>b/);
  assert.match(html, /Me &amp; Co/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /<h1[^>]*>Hi &lt;b&gt;<\/h1>/);
  assert.match(html, /display:none[^>]*>Hi &lt;b&gt;</); // inbox preheader
});

/* ---- Redis / Upstash env parsing ------------------------------------------------------------ */
test('rediss:// Upstash URL is parsed with TLS and decoded password', () => {
  const r = parseRedisUrl('rediss://default:p%40ss%3Aword@fit-owl-1234.upstash.io:6379');
  assert.equal(r.host, 'fit-owl-1234.upstash.io');
  assert.equal(r.password, 'p@ss:word');
  assert.equal(r.username, 'default');
  assert.equal(r.tls, true);
  assert.equal(r.isUpstash, true);
});

test('redis:// to an Upstash host is upgraded to TLS', () => {
  const r = parseRedisUrl('redis://default:tok@fit-owl-1234.upstash.io:6379');
  assert.equal(r.tls, true);
  assert.equal(r.upgraded, true);
});

test('pasting the redis-cli snippet from the Upstash console works', () => {
  const r = parseRedisUrl('redis-cli --tls -u redis://default:tok@fit-owl-1234.upstash.io:6379');
  assert.equal(r.host, 'fit-owl-1234.upstash.io');
  assert.equal(r.tls, true);
});

test('quoted values and whitespace are cleaned', () => {
  const r = parseRedisUrl('  "rediss://default:tok@h.upstash.io:6379"  ');
  assert.equal(r.host, 'h.upstash.io');
});

test('the Upstash REST url is rejected with a helpful message', () => {
  assert.throws(() => parseRedisUrl('https://fit-owl-1234.upstash.io'), /REST/);
});

test('local redis stays non-TLS, bare host:port accepted', () => {
  assert.equal(parseRedisUrl('redis://127.0.0.1:6379').tls, false);
  assert.equal(parseRedisUrl('localhost:6380').port, 6380);
});

test('discrete REDIS_* variables build a connection', () => {
  const r = parseRedisUrl('', { host: 'x.upstash.io', port: 6379, password: 'a/b+c=', tls: 'true' });
  assert.equal(r.password, 'a/b+c=');
  assert.equal(r.tls, true);
});

test('nothing configured => null', () => assert.equal(parseRedisUrl(''), null));

/* ---- load balancer -------------------------------------------------------------------------- */
const fast = { id: 'fast', rps: 2 };
const slow = { id: 'slow', rps: 1 };

test('balancer splits proportionally to throughput on empty queues', () => {
  const { assignments } = plan(9, [fast, slow], {});
  const n = (id) => assignments.filter((x) => x === id).length;
  assert.equal(n('fast'), 6);
  assert.equal(n('slow'), 3);
});

test('a provider with a long backlog is skipped (the less busy queue is fed)', () => {
  const { assignments } = plan(4, [fast, slow], { fast: 20, slow: 0 });
  assert.deepEqual(assignments, ['slow', 'slow', 'slow', 'slow']);
});

test('balancer skips providers with no quota left and reports the overflow', () => {
  const { assignments, unassigned } = plan(5, [fast, slow], {}, { fast: 0, slow: 2 });
  assert.deepEqual(assignments, ['slow', 'slow']);
  assert.equal(unassigned, 3);
});

test('balancer with no capacity anywhere assigns nothing', () => {
  const r = plan(3, [fast], {}, { fast: 0 });
  assert.equal(r.assignments.length, 0);
  assert.equal(r.unassigned, 3);
});

/* ---- quota periods -------------------------------------------------------------------------- */
test('quota period keys', () => {
  const d = new Date('2026-11-19T23:59:59Z');
  assert.equal(periodKey('day', d), '2026-11-19');
  assert.equal(periodKey('month', d), '2026-11');
});
