// Small DOM + formatting helpers shared by the page modules.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ENT[c]);

/** Lucide icon placeholder; call paint() after inserting it into the DOM. */
export const icon = (name, cls = '') => `<i data-lucide="${name}" class="${cls}"></i>`;
export const paint = () => window.lucide?.createIcons({ icons: window.lucide.icons });

export const num = (n) => new Intl.NumberFormat().format(Math.round(n || 0));
export const ms = (n) => (n >= 10_000 ? `${(n / 1000).toFixed(0)}s` : n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`);
export const bytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(0)} KB` : `${n} B`);
export function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return 'now';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

export function show(el, on = true) {
  el.classList.toggle('hidden', !on);
}

const TOAST = {
  success: ['circle-check', 'text-emerald-500'],
  error: ['circle-x', 'text-rose-500'],
  warn: ['triangle-alert', 'text-amber-500'],
  info: ['info', 'text-sky-500'],
};
export function toast(message, type = 'info', timeout = 4500) {
  const [ic, color] = TOAST[type] || TOAST.info;
  const el = document.createElement('div');
  el.className = 'pop pointer-events-auto flex items-start gap-2.5 rounded-lg border border-zinc-200 bg-white p-3 text-sm shadow-xl dark:border-ink-600 dark:bg-ink-800';
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = `${icon(ic, `mt-0.5 text-base ${color}`)}<p class="min-w-0 flex-1 break-words">${esc(message)}</p><button type="button" class="cursor-pointer text-zinc-400 hover:text-zinc-200" aria-label="Dismiss">${icon('x')}</button>`;
  el.querySelector('button').onclick = () => el.remove();
  $('#toasts').append(el);
  paint();
  if (timeout) setTimeout(() => el.remove(), timeout);
}

export const setBusy = (btn, busy, label) => {
  btn.disabled = busy;
  const span = btn.querySelector('span');
  if (span && label) span.textContent = label;
  const i = btn.querySelector('svg, i');
  if (i) i.classList.toggle('spin', busy);
};
