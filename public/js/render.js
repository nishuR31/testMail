// Pure rendering of the live dashboard from a /api/status snapshot.
import { $, ago, esc, icon, ms, num, paint, show } from './ui.js';

const KIND = {
  live: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  sim: 'border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400',
};
const PROVIDER_ICON = { emailjs: 'mail', resend: 'send', simfast: 'rabbit', simslow: 'turtle' };
export const providerIcon = (p) => PROVIDER_ICON[p.id] || 'flask-conical';

const m = (s, mode, id) => s.metrics?.[mode]?.[id] || {};
export const sum = (s, mode, field) => Object.values(s.metrics?.[mode] || {}).reduce((a, x) => a + (x[field] || 0), 0);

export const queuePending = (s) => Object.values(s.queues || {}).reduce((a, q) => a + q.waiting + q.delayed + q.active, 0);
export const directPending = (s) => Object.values(s.direct || {}).reduce((a, d) => a + d.inflight, 0);

function stat(label, value, tone = '') {
  return `<div class="min-w-0"><div class="stat-num ${tone}">${num(value)}</div><div class="mt-1 truncate text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">${label}</div></div>`;
}

/* ------------------------------------------------------------- mode panels */
export function renderModePanels(s) {
  const dPend = directPending(s);
  const dSent = sum(s, 'direct', 'sent');
  const dThr = sum(s, 'direct', 'throttled');
  const dFail = sum(s, 'direct', 'failed') + dThr;
  const dMs = sum(s, 'direct', 'ms');

  const q = Object.values(s.queues || {});
  const waiting = q.reduce((a, x) => a + x.waiting, 0);
  const active = q.reduce((a, x) => a + x.active, 0);
  const delayed = q.reduce((a, x) => a + x.delayed, 0);
  const qPend = waiting + active + delayed;
  const qSent = sum(s, 'queued', 'sent');
  const qFail = sum(s, 'queued', 'failed');
  const qMs = sum(s, 'queued', 'waitms');

  const direct = `
    <article class="card p-5" aria-label="Direct mode stats">
      <header class="mb-4 flex items-center justify-between">
        <h3 class="flex items-center gap-2 text-sm font-semibold">${icon('zap', 'text-amber-500')} Direct <span class="text-xs font-normal text-zinc-500">no queue</span></h3>
        <span class="pill ${dPend ? 'border-amber-500/40 bg-amber-500/10 text-amber-500' : 'border-zinc-300 text-zinc-500 dark:border-ink-600'}">${dPend ? icon('loader-circle', 'spin') : icon('circle-check')} ${dPend ? `${dPend} in flight` : 'idle'}</span>
      </header>
      <div class="grid grid-cols-3 gap-3">
        ${stat('Pending', dPend, dPend ? 'text-amber-500' : '')}
        ${stat('Sent', dSent, 'text-emerald-500')}
        ${stat('Failed', dFail, dFail ? 'text-rose-500' : '')}
      </div>
      <dl class="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-zinc-200 pt-3 text-xs text-zinc-500 dark:border-ink-700 dark:text-zinc-400">
        <dt>Rate-limited (429)</dt><dd class="text-right font-mono ${dThr ? 'text-rose-500' : ''}">${num(dThr)}</dd>
        <dt>Avg latency</dt><dd class="text-right font-mono">${dSent ? ms(dMs / dSent) : '-'}</dd>
      </dl>
    </article>`;

  const qOff = !s.queueAvailable;
  const queued = `
    <article class="card p-5 ${qOff ? 'opacity-60' : ''}" aria-label="Queued mode stats">
      <header class="mb-4 flex items-center justify-between">
        <h3 class="flex items-center gap-2 text-sm font-semibold">${icon('layers', 'text-emerald-500')} Queued <span class="text-xs font-normal text-zinc-500">BullMQ</span></h3>
        <span class="pill ${qOff ? 'border-rose-500/40 bg-rose-500/10 text-rose-500' : s.paused ? 'border-amber-500/40 bg-amber-500/10 text-amber-500' : qPend ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500' : 'border-zinc-300 text-zinc-500 dark:border-ink-600'}">${qOff ? `${icon('plug-zap')} unavailable` : s.paused ? `${icon('pause')} paused` : qPend ? `${icon('loader-circle', 'spin')} processing` : `${icon('circle-check')} idle`}</span>
      </header>
      <div class="grid grid-cols-3 gap-3">
        ${stat('Pending', qPend, qPend ? 'text-emerald-500' : '')}
        ${stat('Sent', qSent, 'text-emerald-500')}
        ${stat('Failed', qFail, qFail ? 'text-rose-500' : '')}
      </div>
      <dl class="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-zinc-200 pt-3 text-xs text-zinc-500 dark:border-ink-700 dark:text-zinc-400">
        <dt>Waiting / active / delayed</dt><dd class="text-right font-mono">${waiting} / ${active} / ${delayed}</dd>
        <dt>Retried &middot; failed over</dt><dd class="text-right font-mono">${num(sum(s, 'queued', 'retried'))} &middot; ${num(sum(s, 'queued', 'failover'))}</dd>
        <dt>Throttled (honoured 429s)</dt><dd class="text-right font-mono">${num(sum(s, 'queued', 'throttled'))}</dd>
        <dt>Avg time in queue</dt><dd class="text-right font-mono">${qSent ? ms(qMs / qSent) : '-'}</dd>
      </dl>
    </article>`;

  $('#mode-panels').innerHTML = direct + queued;
  $('#mode-count-direct').textContent = dPend;
  $('#mode-count-queued').textContent = qPend;
  const badge = $('#tab-badge');
  badge.textContent = dPend + qPend;
  show(badge, dPend + qPend > 0);
  paint();
}

/* ------------------------------------------------------ load distribution */
const SEG = ['bg-emerald-500', 'bg-sky-500', 'bg-violet-500', 'bg-amber-500', 'bg-rose-500'];
const DOT = ['bg-emerald-500', 'bg-sky-500', 'bg-violet-500', 'bg-amber-500', 'bg-rose-500'];

export function renderDistribution(s) {
  const el = $('#distribution');
  const rows = s.providers.map((p, i) => ({ p, i, n: m(s, 'queued', p.id).sent || 0 })).filter((r) => r.n > 0);
  const total = rows.reduce((a, r) => a + r.n, 0);
  if (!total) {
    el.innerHTML = `<p class="well subtle flex items-center gap-2 px-3 py-2 text-xs">${icon('chart-no-axes-column')} Queued deliveries per provider will show here once the balancer has sent something.</p>`;
    return paint();
  }
  el.innerHTML = `
    <div class="mb-1.5 flex items-center justify-between text-xs"><span class="subtle font-medium uppercase tracking-wide">Queued deliveries by provider</span><span class="subtle font-mono">${num(total)} total</span></div>
    <div class="flex h-2.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-ink-700" role="img" aria-label="Share of queued deliveries per provider">
      ${rows.map((r) => `<div class="bar ${SEG[r.i % SEG.length]}" style="width:${(r.n / total) * 100}%" title="${esc(r.p.label)}: ${r.n}"></div>`).join('')}
    </div>
    <ul class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
      ${rows.map((r) => `<li class="flex items-center gap-1.5"><span class="size-2 rounded-full ${DOT[r.i % DOT.length]}"></span><span class="subtle">${esc(r.p.label)}</span><span class="font-mono">${Math.round((r.n / total) * 100)}%</span></li>`).join('')}
    </ul>`;
  paint();
}

/* ---------------------------------------------------------- provider table */
const pill = (txt, tone) => `<span class="pill !px-2 !py-0.5 ${tone}">${txt}</span>`;

export function renderProviders(s) {
  const maxBacklog = Math.max(1, ...Object.values(s.queues || {}).map((x) => x.waiting + x.delayed + x.active));
  const rows = s.providers.map((p) => {
    const q = s.queues?.[p.id];
    const backlog = q ? q.waiting + q.delayed + q.active : 0;
    const dm = m(s, 'direct', p.id);
    const qm = m(s, 'queued', p.id);
    const eta = p.rps > 0 ? backlog / p.rps : 0;
    const quota = p.quota;
    const pct = quota ? Math.min(100, (quota.used / quota.limit) * 100) : 0;
    const qTone = pct >= 90 ? 'bg-rose-500' : pct >= 70 ? 'bg-amber-500' : 'bg-emerald-500';
    const share = q ? Math.round((backlog / maxBacklog) * 100) : 0;

    return `
    <div class="rounded-lg border border-zinc-200 p-3.5 dark:border-ink-700 ${p.configured ? '' : 'opacity-60'}">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span class="flex items-center gap-2 text-sm font-semibold">${icon(providerIcon(p), 'text-base text-zinc-400')} ${esc(p.label)}</span>
        ${pill(p.kind === 'sim' ? 'simulated' : 'live', KIND[p.kind])}
        ${pill(`${p.rps}/s`, 'border-zinc-300 text-zinc-500 dark:border-ink-600 dark:text-zinc-400')}
        ${p.configured ? '' : pill(`${icon('key-round')} <span class="min-w-0 break-all">set ${esc(p.missing.join(', '))}</span>`, 'max-w-full !whitespace-normal !rounded-lg border-rose-500/30 bg-rose-500/10 text-rose-500')}
        ${quota ? `<span class="ml-auto font-mono text-xs text-zinc-500 dark:text-zinc-400" title="Free-tier quota, tracked by this app">${num(quota.used)} / ${num(quota.limit)} ${quota.period === 'day' ? 'today' : 'this month'}</span>` : '<span class="ml-auto text-xs text-zinc-500">no quota</span>'}
      </div>
      ${quota ? `<div class="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-ink-700" role="progressbar" aria-valuenow="${quota.used}" aria-valuemax="${quota.limit}" aria-label="${esc(p.label)} quota"><div class="bar h-full ${qTone}" style="width:${pct}%"></div></div>` : ''}
      <div class="mt-3 grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
        <div class="rounded-md bg-zinc-100 p-2.5 dark:bg-ink-900">
          <div class="mb-1.5 flex items-center gap-1.5 font-medium text-zinc-600 dark:text-zinc-300">${icon('zap', 'text-amber-500')} Direct</div>
          <div class="flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-zinc-500 dark:text-zinc-400">
            <span>in-flight <b class="text-zinc-800 dark:text-zinc-100">${s.direct?.[p.id]?.inflight || 0}</b></span>
            <span>sent <b class="text-emerald-500">${num(dm.sent)}</b></span>
            <span>failed <b class="${(dm.failed || 0) + (dm.throttled || 0) ? 'text-rose-500' : 'text-zinc-800 dark:text-zinc-100'}">${num((dm.failed || 0) + (dm.throttled || 0))}</b></span>
          </div>
        </div>
        <div class="rounded-md bg-zinc-100 p-2.5 dark:bg-ink-900">
          <div class="mb-1.5 flex items-center gap-1.5 font-medium text-zinc-600 dark:text-zinc-300">${icon('layers', 'text-emerald-500')} Queue ${q && backlog ? `<span class="ml-auto font-mono font-normal text-zinc-500">ETA ${ms(eta * 1000)}</span>` : ''}</div>
          ${q
            ? `<div class="flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-zinc-500 dark:text-zinc-400">
                <span>waiting <b class="text-zinc-800 dark:text-zinc-100">${q.waiting}</b></span>
                <span>active <b class="text-zinc-800 dark:text-zinc-100">${q.active}</b></span>
                <span>delayed <b class="text-zinc-800 dark:text-zinc-100">${q.delayed}</b></span>
                <span>sent <b class="text-emerald-500">${num(qm.sent)}</b></span>
                <span>failed <b class="${qm.failed ? 'text-rose-500' : 'text-zinc-800 dark:text-zinc-100'}">${num(qm.failed)}</b></span>
              </div>
              <div class="mt-2 h-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-ink-700"><div class="bar h-full bg-emerald-500" style="width:${share}%"></div></div>`
            : `<span class="text-zinc-500">${p.configured ? 'queue unavailable' : 'not consuming (unconfigured)'}</span>`}
        </div>
      </div>
    </div>`;
  });
  $('#provider-table').innerHTML = rows.join('') || '<p class="text-sm text-zinc-500">No providers enabled.</p>';

  const pb = $('#btn-pause');
  pb.innerHTML = `${icon(s.paused ? 'play' : 'pause')} <span>${s.paused ? 'Resume queues' : 'Pause queues'}</span>`;
  pb.disabled = !s.queueAvailable;
  $('#btn-clear-q').disabled = !s.queueAvailable;
  paint();
}

/* --------------------------------------------------------------------- log */
const STATUS = {
  sent: ['circle-check', 'text-emerald-500', 'sent'],
  queued: ['inbox', 'text-sky-500', 'queued'],
  retry: ['repeat', 'text-amber-500', 'retry'],
  failover: ['shuffle', 'text-violet-500', 'failover'],
  failed: ['circle-x', 'text-rose-500', 'failed'],
};

export function filterLog(s, filter, query = '') {
  const q = query.trim().toLowerCase();
  return (s.log || [])
    .filter((e) => (filter === 'all' ? true : filter === 'failed' ? ['failed', 'retry', 'failover'].includes(e.status) : e.mode === filter))
    .filter((e) => !q || [e.to, e.subject, e.error, e.detail, e.provider, e.status].some((v) => String(v ?? '').toLowerCase().includes(q)));
}

export function renderLog(s, filter, query = '') {
  const labelOf = Object.fromEntries(s.providers.map((p) => [p.id, p.label]));
  const rows = filterLog(s, filter, query);
  const ol = $('#log');
  $('#log-count').textContent = rows.length === (s.log || []).length ? `${rows.length}` : `${rows.length} / ${(s.log || []).length}`;
  if (!rows.length) {
    const filtered = (s.log || []).length > 0;
    ol.innerHTML = `<li class="flex flex-col items-center gap-2 py-10 text-sm text-zinc-500">${icon(filtered ? 'search-x' : 'inbox', 'text-2xl')}<span>${filtered ? 'Nothing matches this filter.' : 'No activity yet. Send a test email.'}</span></li>`;
    return paint();
  }
  ol.innerHTML = rows
    .map((e) => {
      const [ic, tone, label] = STATUS[e.status] || STATUS.queued;
      const who = e.provider === 'balanced' ? 'balanced' : labelOf[e.provider] || e.provider || '';
      const target = e.target ? ` -> ${esc(labelOf[e.target] || e.target)}` : '';
      const detail = e.error ? esc(e.error) : e.detail ? esc(e.detail) : esc(e.subject || '');
      const sub = [e.to ? esc(e.to) : '', e.attach ? `${icon('paperclip')} ${esc(e.attach)}` : '', e.rescued ? `rescued from ${esc(labelOf[e.rescued] || e.rescued)}` : '', e.attempt > 1 ? `attempt ${e.attempt}` : '']
        .filter(Boolean)
        .join(' &middot; ');
      return `<li class="flex items-start gap-2.5 rounded-lg px-2.5 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-ink-800">
        ${icon(ic, `mt-0.5 text-base ${tone}`)}
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-x-2 text-xs">
            <span class="font-semibold ${tone}">${label}${target}</span>
            <span class="rounded bg-zinc-200 px-1.5 py-px font-mono text-[10px] uppercase text-zinc-600 dark:bg-ink-700 dark:text-zinc-300">${e.mode}</span>
            <span class="text-zinc-500 dark:text-zinc-400">${esc(who)}</span>
            ${e.ms != null ? `<span class="font-mono text-zinc-500">${ms(e.ms)}</span>` : ''}
            ${e.waitedMs ? `<span class="font-mono text-zinc-500" title="Time spent in queue">queue ${ms(e.waitedMs)}</span>` : ''}
          </div>
          <p class="truncate text-zinc-700 dark:text-zinc-300" title="${detail}">${detail}</p>
          ${sub ? `<p class="flex flex-wrap items-center gap-1 truncate text-xs text-zinc-500">${sub}</p>` : ''}
        </div>
        <time class="shrink-0 font-mono text-xs text-zinc-500">${ago(e.ts)}</time>
      </li>`;
    })
    .join('');
  paint();
}

/* ------------------------------------------------------------ header/banner */
export function renderHeader(s) {
  const r = s.redis;
  const rp = $('#redis-pill');
  const tone = r.status === 'ready' ? ['border-emerald-500/40 bg-emerald-500/10 text-emerald-500', 'database', `Redis ${r.upstash ? '(Upstash) ' : ''}ready`]
    : r.status === 'off' ? ['border-zinc-300 text-zinc-500 dark:border-ink-600', 'database', 'Redis off']
    : r.error || r.status === 'end' ? ['border-rose-500/40 bg-rose-500/10 text-rose-500', 'database', 'Redis error']
    : ['border-amber-500/40 bg-amber-500/10 text-amber-500', 'loader-circle', 'Redis connecting'];
  rp.className = `pill ${tone[0]}`;
  rp.innerHTML = `${icon(tone[1], tone[1] === 'loader-circle' ? 'spin' : '')} <span class="hidden sm:inline">${tone[2]}</span>`;
  rp.title = [r.host, r.tls ? 'TLS' : 'no TLS', r.note, r.error].filter(Boolean).join(' - ');

  const n = s.workers.length;
  const wp = $('#workers-pill');
  wp.className = `pill ${n ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500' : r.status === 'ready' ? 'border-amber-500/40 bg-amber-500/10 text-amber-500' : 'border-zinc-300 text-zinc-500 dark:border-ink-600'}`;
  wp.innerHTML = `${icon('cpu')} ${n} worker${n === 1 ? '' : 's'}`;
  wp.title = n ? s.workers.map((w) => `${w.id} (${(w.providers || []).join(', ')})`).join('\n') : 'No worker process has reported in';

  $('#env-badge').textContent = s.env === 'production' ? 'prod' : 'dev';
  $('#updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  show($('#btn-key'), !!s.auth?.required);
  paint();
}

export function renderBanner(s, extra) {
  const items = [];
  if (extra) items.push(['rose', 'lock', extra]);
  if (s) {
    if (s.redis.error) items.push(['rose', 'database', s.redis.error]);
    else if (s.redis.status === 'off') items.push(['amber', 'database', 'Redis is not configured: Queued mode is disabled. Set REDIS_URL (Upstash: rediss://default:TOKEN@HOST.upstash.io:6379).']);
    if (s.queueAvailable && !s.workers.length) items.push(['amber', 'cpu', 'No queue worker is running. Jobs will wait until one starts (npm start or npm run worker).']);
    if (s.paused) items.push(['amber', 'pause', 'Queues are paused. Jobs accumulate until you resume.']);
    if (!s.providers.some((p) => p.configured && p.kind === 'live')) items.push(['sky', 'info', 'No live provider is configured yet. Simulators are available for testing, add EMAILJS_* / RESEND_API_KEY to send real mail.']);
  }
  const el = $('#banner');
  show(el, items.length > 0);
  const tone = { rose: 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-300', amber: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300', sky: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300' };
  el.innerHTML = `<div class="mx-auto max-w-7xl space-y-2 px-4 pt-4">${items
    .map(([t, ic, msg]) => `<div role="status" class="flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm ${tone[t]}">${icon(ic, 'mt-0.5 shrink-0')}<span>${esc(msg)}</span></div>`)
    .join('')}</div>`;
  paint();
}
