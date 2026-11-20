// Resend REST API  https://resend.com/docs/api-reference/emails/send-email
// Free tier: 100 emails/day. Default API limit: 2 requests/second.
// Without a verified domain you can only send FROM onboarding@resend.dev TO your own Resend account email.
import { config } from '../config.js';
import { ProviderError } from '../errors.js';
import { renderHtmlEmail } from './html-template.js';
import { kindFromStatus, request, retryAfterMs, trim } from './http.js';

const ENDPOINT = 'https://api.resend.com/emails';
const cfg = config.providers.resend;

function parseError(text) {
  try {
    const j = JSON.parse(text);
    return { name: j.name, message: j.message || text };
  } catch {
    return { message: text };
  }
}

export const resend = {
  id: 'resend',
  label: 'Resend',
  kind: 'live',
  rps: cfg.rps,
  quota: cfg.limit > 0 ? { limit: cfg.limit, period: 'day' } : null,
  missing: () => (cfg.apiKey ? [] : ['RESEND_API_KEY']),
  attachments: () => ({ supported: true, maxBytes: 10 * 1024 * 1024 }),

  async send(email, { idempotencyKey } = {}) {
    const body = {
      from: cfg.from,
      to: [email.to],
      subject: email.subject,
      text: email.message,
      html: renderHtmlEmail({ subject: email.subject, message: email.message, fromName: cfg.from }),
    };
    if (email.attachment) body.attachments = [{ filename: email.attachment.filename, content: email.attachment.content }];
    const headers = { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json', 'User-Agent': 'mailbench/1.0' };
    // Same key on a retry => Resend de-duplicates, so a retried job can never double-send.
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    const res = await request(ENDPOINT, { headers, body: JSON.stringify(body) });
    if (res.status >= 200 && res.status < 300) {
      let id = null;
      try {
        id = JSON.parse(res.text).id ?? null;
      } catch {
        /* ignore */
      }
      return { id };
    }

    const err = parseError(res.text);
    let kind = kindFromStatus(res.status);
    if (res.status === 429 && /quota/i.test(`${err.name} ${err.message}`)) kind = 'quota'; // retrying is pointless
    if (res.status === 409) kind = 'server'; // concurrent_idempotent_requests: safe to retry
    throw new ProviderError(`Resend ${res.status}${err.name ? ` ${err.name}` : ''}: ${trim(err.message || 'no body')}`, {
      kind,
      status: res.status,
      retryAfterMs: kind === 'rate_limit' ? retryAfterMs(res.headers) : undefined,
    });
  },

  /** Non-sending credential check used by diagnostics. */
  async check() {
    const res = await request('https://api.resend.com/domains', {
      method: 'GET',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'User-Agent': 'mailbench/1.0' },
      timeoutMs: 10_000,
    });
    const err = parseError(res.text);
    if (res.status === 200) {
      let domains = [];
      try {
        domains = JSON.parse(res.text).data || [];
      } catch {
        /* ignore */
      }
      const verified = domains.filter((d) => d.status === 'verified').length;
      return { ok: true, detail: `API key valid, ${verified}/${domains.length} verified domain(s)` };
    }
    if (res.status === 401 && err.name === 'restricted_api_key') return { ok: true, detail: 'API key valid (sending-only access)' };
    return { ok: false, detail: `Resend ${res.status}: ${trim(err.message || '', 120)}` };
  },
};
