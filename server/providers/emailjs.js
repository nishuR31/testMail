// EmailJS REST API  https://www.emailjs.com/docs/rest-api/send/
// Needs "Allow EmailJS API for non-browser applications" (Account > Security) switched on.
// Free tier: 200 requests / month, 1 request / second on the REST endpoint.
import { config } from '../config.js';
import { ProviderError } from '../errors.js';
import { kindFromStatus, request, retryAfterMs, trim } from './http.js';

const ENDPOINT = 'https://api.emailjs.com/api/v1.0/email/send';
const cfg = config.providers.emailjs;

// The configured template (template_v3ixl79) names its variables {{email}}, {{name}} and {{time}}.
// Send those alongside the standard aliases so other EmailJS templates keep working too.
export function buildTemplateParams(email) {
  return {
    to_email: email.to,
    email: email.to,
    reply_to: email.to,
    from_name: cfg.fromName,
    name: cfg.fromName,
    subject: email.subject,
    message: email.message,
    time: new Date().toLocaleString(),
  };
}

export const emailjs = {
  id: 'emailjs',
  label: 'EmailJS',
  kind: 'live',
  rps: cfg.rps,
  quota: cfg.limit > 0 ? { limit: cfg.limit, period: 'month' } : null,
  missing() {
    const m = [];
    if (!cfg.serviceId) m.push('EMAILJS_SERVICE_ID');
    if (!cfg.templateId) m.push('EMAILJS_TEMPLATE_ID');
    if (!cfg.publicKey) m.push('EMAILJS_PUBLIC_KEY');
    return m;
  },
  // Attachments need a "Variable attachment" in the EmailJS template (paid feature).
  attachments() {
    return cfg.attachmentParam
      ? { supported: true, maxBytes: cfg.maxAttachmentBytes }
      : { supported: false, reason: 'Set EMAILJS_ATTACHMENT_PARAM (needs a paid-plan variable attachment)' };
  },

  async send(email) {
    const params = buildTemplateParams(email);
    if (email.attachment) {
      if (!cfg.attachmentParam) {
        throw new ProviderError('EmailJS attachment parameter is not configured (EMAILJS_ATTACHMENT_PARAM)', { kind: 'config' });
      }
      params[cfg.attachmentParam] = `data:${email.attachment.contentType};base64,${email.attachment.content}`;
    }
    const body = { service_id: cfg.serviceId, template_id: cfg.templateId, user_id: cfg.publicKey, template_params: params };
    if (cfg.privateKey) body.accessToken = cfg.privateKey;

    const res = await request(ENDPOINT, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (res.status === 200) return { id: null };

    const kind = kindFromStatus(res.status);
    throw new ProviderError(`EmailJS ${res.status}: ${trim(res.text || 'no body')}`, {
      kind,
      status: res.status,
      retryAfterMs: kind === 'rate_limit' ? retryAfterMs(res.headers) : undefined,
    });
  },
};
