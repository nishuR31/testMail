import { config } from './config.js';
import { HttpError } from './errors.js';
import { enabledProviders } from './providers/index.js';

const EMAIL_RE = /^[^\s@<>()[\],;:"\\]+@[^\s@<>()[\],;:"\\]+\.[^\s@<>()[\],;:"\\]{2,}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function str(v, field, { min = 0, max, trim = true } = {}) {
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be a string`, field);
  const s = trim ? v.trim() : v;
  if (s.length < min) throw new HttpError(400, `${field} is required`, field);
  if (max && s.length > max) throw new HttpError(400, `${field} is too long (max ${max} characters)`, field);
  return s;
}

function checkRecipient(to) {
  if (!EMAIL_RE.test(to) || to.length > 254) throw new HttpError(400, 'Enter a valid recipient email address', 'to');
  const list = config.allowedRecipients;
  if (list.length) {
    const lower = to.toLowerCase();
    const domain = lower.split('@')[1];
    if (!list.includes(lower) && !list.includes(domain) && !list.includes(`@${domain}`)) {
      throw new HttpError(403, 'Recipient is not in ALLOWED_RECIPIENTS', 'to');
    }
  }
}

function parseAttachment(a) {
  if (a == null) return null;
  if (typeof a !== 'object') throw new HttpError(400, 'attachment is invalid', 'attachment');
  const filename = str(a.filename ?? '', 'attachment.filename', { min: 1, max: 160 }).replace(/[\\/:*?"<>|\r\n\0]/g, '_');
  const contentType = /^[\w.+-]+\/[\w.+-]+$/.test(a.contentType || '') ? a.contentType : 'application/octet-stream';
  const content = str(a.content ?? '', 'attachment.content', { min: 1, trim: true });
  if (!B64_RE.test(content) || content.length % 4 === 1) throw new HttpError(400, 'attachment must be base64 encoded', 'attachment');
  const bytes = Math.floor((content.length * 3) / 4) - (content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0);
  if (bytes > config.maxAttachmentBytes) {
    throw new HttpError(413, `Attachment is ${(bytes / 1024).toFixed(0)} KB; the limit is ${Math.round(config.maxAttachmentBytes / 1024)} KB`, 'attachment');
  }
  return { filename, contentType, content, bytes };
}

/** Validates and normalises the body of POST /api/send. */
export function parseSendBody(body) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'Invalid JSON body');

  const to = str(body.to ?? '', 'to', { min: 1, max: 254 });
  checkRecipient(to);
  const subject = str(body.subject ?? '', 'subject', { min: 1, max: 200 });
  if (/[\r\n]/.test(subject)) throw new HttpError(400, 'subject must be a single line', 'subject');
  const message = str(body.message ?? '', 'message', { min: 1, max: 20_000, trim: false });
  const attachment = parseAttachment(body.attachment);

  const mode = body.mode === 'queued' ? 'queued' : body.mode === 'direct' ? 'direct' : null;
  if (!mode) throw new HttpError(400, 'mode must be "direct" or "queued"', 'mode');

  const enabled = new Map(enabledProviders().map((p) => [p.id, p]));
  const ids = [...new Set(Array.isArray(body.providers) ? body.providers : [])];
  if (!ids.length) throw new HttpError(400, 'Select at least one provider', 'providers');
  const warnings = [];
  let pool = [];
  for (const id of ids) {
    const p = enabled.get(id);
    if (!p) throw new HttpError(400, `Unknown or disabled provider "${id}"`, 'providers');
    const missing = p.missing();
    if (missing.length) throw new HttpError(400, `${p.label} is not configured (missing ${missing.join(', ')})`, 'providers');
    if (attachment) {
      const cap = p.attachments();
      if (!cap.supported) {
        warnings.push(`${p.label} skipped: ${cap.reason}`);
        continue;
      }
      if (attachment.bytes > cap.maxBytes) {
        warnings.push(`${p.label} skipped: attachment exceeds its ${Math.round(cap.maxBytes / 1024)} KB limit`);
        continue;
      }
    }
    pool.push(p);
  }
  if (!pool.length) throw new HttpError(400, warnings.join('; ') || 'No usable provider selected', 'providers');

  const usesSim = pool.some((p) => p.kind === 'sim');
  const usesLive = pool.some((p) => p.kind === 'live');
  const maxCount = usesLive ? config.burstMaxReal : config.burstMaxSim;
  const count = Math.floor(Number(body.count ?? 1));
  if (!Number.isFinite(count) || count < 1 || count > maxCount) {
    throw new HttpError(400, `count must be between 1 and ${maxCount}${usesLive ? ' when a real provider is selected' : ''}`, 'count');
  }

  let simFailRate;
  if (usesSim && body.simFailRate != null) {
    const f = Number(body.simFailRate);
    if (!Number.isFinite(f) || f < 0 || f > 1) throw new HttpError(400, 'simFailRate must be between 0 and 1', 'simFailRate');
    simFailRate = f;
  }

  return { email: { to, subject, message, attachment, simFailRate }, mode, pool, count, warnings };
}

/** What gets stored on a queue job / logged, without the (large) attachment body. */
export const describeEmail = (e) => ({ to: e.to, subject: e.subject, attach: e.attachment ? e.attachment.filename : undefined });
