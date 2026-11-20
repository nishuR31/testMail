// Hardcoded, self-contained HTML email template. No provider-side template setup is needed:
// Resend accepts raw HTML, so the app builds the entire message itself (EmailJS cannot do this —
// its send API always requires a configured template_id).

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function renderHtmlEmail({ subject, message, fromName }) {
  const title = escapeHtml(subject);
  const body = escapeHtml(message).replace(/\r?\n/g, '<br>');
  const footer = fromName ? `Sent via Mailbench &middot; ${escapeHtml(fromName)}` : 'Sent via Mailbench';
  return [
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${title}</title></head>`,
    '<body style="margin:0;padding:24px;background:#f4f4f5;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif">',
    `<div style="display:none;font-size:1px;color:#fff;max-height:0;overflow:hidden">${title}</div>`,
    '<div style="max-width:600px;margin:auto;background:#fff;border:1px solid #e4e4e7;border-radius:14px;overflow:hidden">',
    '<div style="background:#18181b;padding:18px 28px;color:#fff;font-size:13px;letter-spacing:.1em;text-transform:uppercase">Mailbench</div>',
    '<div style="padding:28px">',
    `<h1 style="margin:0 0 16px;font-size:24px;line-height:1.3;color:#18181b">${title}</h1>`,
    `<div style="font-size:15px;line-height:1.7;color:#3f3f46">${body}</div>`,
    '</div>',
    `<div style="border-top:1px solid #f4f4f5;padding:16px 28px;color:#a1a1aa;font-size:12px">${footer}</div>`,
    '</div></body></html>',
  ].join('');
}
