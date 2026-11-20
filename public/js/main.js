import { api, ApiError, getToken, setToken } from './api.js';
import { filterLog, renderBanner, renderDistribution, renderHeader, renderLog, renderModePanels, renderProviders, providerIcon, queuePending, directPending, sum } from './render.js';
import { $, $$, bytes, esc, icon, num, paint, setBusy, show, toast } from './ui.js';

const state = {
  status: null,
  mode: localStorage.getItem('mb-mode') === 'queued' ? 'queued' : 'direct',
  selected: new Set(JSON.parse(localStorage.getItem('mb-providers') || '[]')),
  filter: 'all',
  query: '',
  view: ['compose', 'dashboard', 'activity'].includes(localStorage.getItem('mb-view')) ? localStorage.getItem('mb-view') : 'compose',
  benching: false,
  live: true,
  attachment: null, // { filename, contentType, content, bytes }
  sending: false,
  providerSig: '',
  timer: null,
  fetching: false,
  fastUntil: 0,
};

/* ------------------------------------------------------------------ theme */
function applyTheme(dark) {
  document.documentElement.classList.toggle('dark', dark);
  localStorage.setItem('mb-theme', dark ? 'dark' : 'light');
  $('#btn-theme').innerHTML = icon(dark ? 'sun' : 'moon');
  document.querySelector('meta[name=theme-color]').content = dark ? '#0a0b0f' : '#fafafa';
  paint();
}
$('#btn-theme').onclick = () => applyTheme(!document.documentElement.classList.contains('dark'));

/* ------------------------------------------------------- mobile tab view */
function paintView() {
  document.body.dataset.view = state.view;
  for (const t of $$('#tabbar .tab')) {
    if (t.dataset.view === state.view) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  }
}
for (const t of $$('#tabbar .tab')) {
  t.onclick = () => {
    state.view = t.dataset.view;
    localStorage.setItem('mb-view', state.view);
    paintView();
    window.scrollTo({ top: 0 });
  };
}

/* ------------------------------------------------------------ mode switch */
function paintMode() {
  for (const b of $$('.mode-btn')) {
    const on = b.dataset.mode === state.mode;
    b.setAttribute('aria-checked', String(on));
    b.className = `mode-btn flex cursor-pointer items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-left transition ${
      on ? 'bg-white text-zinc-900 shadow-sm ring-1 ring-emerald-500/50 dark:bg-ink-700 dark:text-zinc-50' : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100'
    }`;
    b.querySelector('.mode-count').className = `mode-count rounded-md px-1.5 py-0.5 font-mono text-xs tabular-nums ${on ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-zinc-200 dark:bg-ink-800'}`;
  }
  const q = state.mode === 'queued';
  $('#send-label').textContent = q ? 'Add to queue' : 'Send now';
  const s = state.status;
  const blocked = q && s && !s.queueAvailable;
  $('#btn-send').disabled = state.sending || blocked;
  $('#send-note').textContent = blocked
    ? 'Queued mode needs a working Redis connection.'
    : q
      ? 'Jobs are load-balanced across the selected providers, rate-limited and retried by BullMQ.'
      : 'Sent immediately from this request: no throttling, no retry, no failover.';
}
for (const b of $$('.mode-btn')) {
  b.onclick = () => {
    state.mode = b.dataset.mode;
    localStorage.setItem('mb-mode', state.mode);
    paintMode();
  };
}
$('#mode-switch').addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  state.mode = state.mode === 'direct' ? 'queued' : 'direct';
  localStorage.setItem('mb-mode', state.mode);
  paintMode();
  $(`.mode-btn[data-mode="${state.mode}"]`).focus();
});

/* -------------------------------------------------------------- providers */
function renderProviderChoices(s) {
  const sig = JSON.stringify(s.providers.map((p) => [p.id, p.configured, p.attachments.supported]));
  if (sig === state.providerSig) return;
  state.providerSig = sig;
  // first visit: preselect everything that can actually send
  if (!localStorage.getItem('mb-providers')) for (const p of s.providers) if (p.configured && p.kind === 'live') state.selected.add(p.id);
  if (!state.selected.size) for (const p of s.providers) if (p.kind === 'sim') state.selected.add(p.id);
  for (const id of [...state.selected]) if (!s.providers.find((p) => p.id === id && p.configured)) state.selected.delete(id);

  $('#provider-list').innerHTML = s.providers
    .map(
      (p) => `
    <label class="flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-sm transition ${p.configured ? 'cursor-pointer border-zinc-300 hover:border-emerald-500/60 dark:border-ink-600' : 'cursor-not-allowed border-zinc-200 opacity-50 dark:border-ink-700'} has-[:checked]:border-emerald-500 has-[:checked]:bg-emerald-500/10">
      <input type="checkbox" class="peer sr-only" value="${esc(p.id)}" ${p.configured ? '' : 'disabled'} ${state.selected.has(p.id) ? 'checked' : ''}>
      ${icon(providerIcon(p), 'text-base text-zinc-400 peer-checked:text-emerald-500')}
      <span class="min-w-0 flex-1"><span class="block truncate font-medium leading-tight">${esc(p.label)}</span><span class="block truncate text-[11px] leading-tight text-zinc-500">${p.configured ? `${p.kind === 'sim' ? 'simulated' : 'live'} &middot; ${p.rps}/s${p.attachments.supported ? '' : ' &middot; no attachments'}` : `missing ${esc(p.missing.join(', '))}`}</span></span>
      <span class="hidden size-4 place-items-center rounded-full bg-emerald-500 text-ink-950 peer-checked:grid">${icon('check', 'text-[10px]')}</span>
    </label>`
    )
    .join('');
  for (const cb of $$('#provider-list input')) {
    cb.onchange = () => {
      cb.checked ? state.selected.add(cb.value) : state.selected.delete(cb.value);
      localStorage.setItem('mb-providers', JSON.stringify([...state.selected]));
      syncControls();
    };
  }
  syncControls();
  paint();
}

function selectedProviders() {
  return (state.status?.providers || []).filter((p) => state.selected.has(p.id));
}

function syncControls() {
  const s = state.status;
  if (!s) return;
  const sel = selectedProviders();
  const live = sel.some((p) => p.kind === 'live');
  const sim = sel.some((p) => p.kind === 'sim');
  const max = live ? s.limits.burstReal : s.limits.burstSim;
  const range = $('#f-count');
  range.max = String(max);
  if (+range.value > max) range.value = String(max);
  $('#count-val').textContent = range.value;
  $('#count-hint').textContent = live ? `max ${max} with a real provider (protects free quota)` : `max ${max} (simulators only)`;
  const presets = [1, 5, 10, 25, 50, 100].filter((n) => n <= max);
  const box = $('#burst-presets');
  if (box.dataset.sig !== presets.join()) {
    box.dataset.sig = presets.join();
    box.innerHTML = presets.map((n) => `<button type="button" class="chip" data-n="${n}">${n}</button>`).join('');
    for (const b of $$('.chip', box)) b.onclick = () => ((range.value = b.dataset.n), syncControls());
  }
  for (const b of $$('.chip', box)) {
    const on = b.dataset.n === range.value;
    b.classList.toggle('!border-emerald-500', on);
    b.classList.toggle('!text-emerald-500', on);
  }
  show($('#fail-wrap'), sim);
  $('#fail-val').textContent = `${$('#f-fail').value}%`;
  $('#att-limit').textContent = `max ${s.limits.attachmentKB} KB`;
}
$('#f-count').oninput = syncControls;
$('#f-fail').oninput = syncControls;
$('#f-message').oninput = (e) => ($('#msg-count').textContent = num(e.target.value.length));

/* ------------------------------------------------------------- attachment */
function clearAttachment() {
  state.attachment = null;
  $('#f-file').value = '';
  show($('#att-chip'), false);
  $('#att-chip').classList.remove('flex');
  $('#dz-text').textContent = 'Drop a file or click to browse';
}

async function setFile(file) {
  fieldError('attachment');
  if (!file) return;
  const limit = (state.status?.limits.attachmentKB || 512) * 1024;
  if (file.size > limit) {
    clearAttachment();
    return fieldError('attachment', `File is ${bytes(file.size)}; the limit is ${bytes(limit)}.`);
  }
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  state.attachment = { filename: file.name, contentType: file.type || 'application/octet-stream', content: btoa(bin), bytes: file.size };
  $('#att-name').textContent = file.name;
  $('#att-size').textContent = bytes(file.size);
  show($('#att-chip'));
  $('#att-chip').classList.add('flex');
  $('#dz-text').textContent = 'Replace file';
}
$('#f-file').onchange = (e) => setFile(e.target.files[0]);
$('#att-remove').onclick = clearAttachment;
const dz = $('#dropzone');
['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => (e.preventDefault(), dz.classList.add('border-emerald-500', 'text-emerald-500'))));
['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => (e.preventDefault(), dz.classList.remove('border-emerald-500', 'text-emerald-500'))));
dz.addEventListener('drop', (e) => setFile(e.dataTransfer.files[0]));

/* ------------------------------------------------------------- validation */
function fieldError(name, msg) {
  const p = $(`#err-${name}`);
  const input = $(`#f-${name === 'attachment' ? 'file' : name}`);
  if (!p) return;
  p.textContent = msg || '';
  show(p, !!msg);
  if (input && input.type !== 'file') input.setAttribute('aria-invalid', String(!!msg));
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function validate() {
  let first = null;
  const bad = (name, msg) => (fieldError(name, msg), (first ??= name));
  ['to', 'subject', 'message', 'providers'].forEach((n) => fieldError(n));
  if (!EMAIL.test($('#f-to').value.trim())) bad('to', 'Enter a valid email address.');
  if (!$('#f-subject').value.trim()) bad('subject', 'Subject is required.');
  if (!$('#f-message').value.trim()) bad('message', 'Message is required.');
  if (!state.selected.size) bad('providers', 'Select at least one provider.');
  if (first) $(first === 'providers' ? '#provider-list input:not(:disabled)' : `#f-${first}`)?.focus();
  return !first;
}
for (const n of ['to', 'subject', 'message']) $(`#f-${n}`).addEventListener('input', () => fieldError(n));

/* ------------------------------------------------------------------- send */
function showResult(html, tone) {
  const tones = { ok: 'border-emerald-500/30 bg-emerald-500/10', err: 'border-rose-500/30 bg-rose-500/10', warn: 'border-amber-500/30 bg-amber-500/10' };
  const el = $('#last-result');
  el.className = `pop mt-4 rounded-lg border p-3 text-sm ${tones[tone]}`;
  el.innerHTML = html;
  paint();
}

$('#send-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.sending || !validate()) return;
  state.sending = true;
  const direct = state.mode === 'direct';
  setBusy($('#btn-send'), true, direct ? 'Sending...' : 'Queueing...');
  const body = buildBody();

  state.fastUntil = Date.now() + 20_000;
  const poll = direct ? setInterval(refresh, 700) : null; // show in-flight counters live while the request is open
  try {
    const r = await api('/send', { method: 'POST', body, timeout: 120_000 });
    const warns = (r.warnings || []).map((w) => `<li>${esc(w)}</li>`).join('');
    const warnHtml = warns ? `<ul class="mt-2 list-disc pl-5 text-xs text-amber-600 dark:text-amber-300">${warns}</ul>` : '';
    if (r.mode === 'queued') {
      toast(`${r.accepted} email(s) queued`, 'success');
      const left = r.unassigned ? ` ${r.unassigned} skipped: free-tier quota exhausted.` : '';
      showResult(`<div class="flex items-center gap-2 font-medium">${icon('inbox', 'text-emerald-500')} Queued ${r.accepted} email(s)</div><p class="mt-1 text-xs text-zinc-600 dark:text-zinc-300">Load balanced: ${esc(r.summary || '-')}.${left}</p>${r.workerHint ? `<p class="mt-1 text-xs text-amber-600 dark:text-amber-300">${esc(r.workerHint)}</p>` : ''}${warnHtml}`, r.unassigned ? 'warn' : 'ok');
    } else {
      const fails = r.results.filter((x) => !x.ok);
      toast(r.failed ? `${r.sent} sent, ${r.failed} failed` : `${r.sent} sent`, r.failed ? (r.sent ? 'warn' : 'error') : 'success');
      showResult(
        `<div class="flex items-center gap-2 font-medium">${icon(r.failed ? 'triangle-alert' : 'circle-check', r.failed ? 'text-amber-500' : 'text-emerald-500')} ${r.sent} sent, ${r.failed} failed</div>${fails
          .slice(0, 4)
          .map((f) => `<p class="mt-1 break-words text-xs text-rose-600 dark:text-rose-300">${esc(f.error)}</p>`)
          .join('')}${fails.length > 4 ? `<p class="mt-1 text-xs text-zinc-500">...and ${fails.length - 4} more (see Activity)</p>` : ''}${warnHtml}`,
        r.failed ? (r.sent ? 'warn' : 'err') : 'ok'
      );
    }
  } catch (err) {
    if (err.status === 401) return askToken();
    if (err.field) fieldError(err.field === 'attachment' ? 'attachment' : err.field, err.message);
    toast(err.message, 'error', 7000);
    showResult(`<div class="flex items-start gap-2">${icon('circle-x', 'mt-0.5 text-rose-500')}<span>${esc(err.message)}</span></div>`, 'err');
  } finally {
    clearInterval(poll);
    state.sending = false;
    setBusy($('#btn-send'), false);
    paintMode();
    refresh();
  }
});

function buildBody() {
  const body = {
    to: $('#f-to').value.trim(),
    subject: $('#f-subject').value.trim(),
    message: $('#f-message').value,
    mode: state.mode,
    providers: [...state.selected],
    count: +$('#f-count').value,
  };
  if (state.attachment) body.attachment = { filename: state.attachment.filename, contentType: state.attachment.contentType, content: state.attachment.content };
  if (!$('#fail-wrap').classList.contains('hidden')) body.simFailRate = +$('#f-fail').value / 100;
  return body;
}

$('#btn-clear-form').onclick = () => {
  for (const n of ['to', 'subject', 'message']) {
    $(`#f-${n}`).value = '';
    fieldError(n);
  }
  $('#msg-count').textContent = '0';
  clearAttachment();
  show($('#last-result'), false);
  $('#f-to').focus();
};

$('#btn-curl').onclick = async () => {
  if (!EMAIL.test($('#f-to').value.trim())) return toast('Fill in a valid recipient first.', 'warn');
  const b = buildBody();
  if (b.attachment) b.attachment.content = '<base64 omitted>';
  const tok = getToken() ? ' \\\n  -H "Authorization: Bearer $ACCESS_TOKEN"' : '';
  const cmd = `curl -X POST ${location.origin}/api/send \\\n  -H "Content-Type: application/json"${tok} \\\n  -d '${JSON.stringify(b).replace(/'/g, "'\\''")}'`;
  try {
    await navigator.clipboard.writeText(cmd);
    toast('cURL command copied', 'success', 2000);
  } catch {
    toast('Clipboard blocked by the browser.', 'error');
  }
};

$('#send-form').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#send-form').requestSubmit();
});

$('#btn-sample').onclick = () => {
  const n = new Date().toLocaleTimeString();
  if (!$('#f-subject').value) $('#f-subject').value = `Mailbench test @ ${n}`;
  if (!$('#f-message').value) $('#f-message').value = `Hello,\n\nThis is a test email sent at ${n} to verify delivery, rate limiting and queue behaviour.\n\n- Mailbench`;
  $('#msg-count').textContent = num($('#f-message').value.length);
  $('#f-to').focus();
};

/* ---------------------------------------------------------------- actions */
async function action(btn, path, ok) {
  btn.disabled = true;
  try {
    const r = await api(path, { method: 'POST' });
    if (ok) toast(typeof ok === 'function' ? ok(r) : ok, 'success');
  } catch (err) {
    if (err.status === 401) askToken();
    else toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    refresh();
  }
}
$('#btn-pause').onclick = (e) => action(e.currentTarget, state.status?.paused ? '/queue/resume' : '/queue/pause', state.status?.paused ? 'Queues resumed' : 'Queues paused');
$('#btn-clear-q').onclick = (e) => action(e.currentTarget, '/queue/clear', (r) => `Removed ${r.removed} waiting job(s)`);
$('#btn-reset').onclick = (e) => confirm('Reset all counters and the activity log? Quota usage is kept.') && action(e.currentTarget, '/reset', 'Counters reset');
$('#btn-clear-log').onclick = (e) => action(e.currentTarget, '/log/clear');
$('#btn-refresh').onclick = () => refresh(true);

for (const b of $$('#log-filter button')) {
  b.onclick = () => {
    state.filter = b.dataset.f;
    paintFilter();
    if (state.status) renderLog(state.status, state.filter, state.query);
  };
}
$('#log-q').oninput = (e) => {
  state.query = e.target.value;
  if (state.status) renderLog(state.status, state.filter, state.query);
};

$('#btn-export').onclick = () => {
  if (!state.status) return;
  const rows = filterLog(state.status, state.filter, state.query);
  if (!rows.length) return toast('Nothing to export.', 'warn');
  const cols = ['ts', 'status', 'mode', 'provider', 'to', 'subject', 'ms', 'waitedMs', 'attempt', 'error'];
  // prefix cells that start with = + - @ so spreadsheets do not run them as formulas
  const cell = (v) => {
    let t = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
    return `"${t.replace(/"/g, '""')}"`;
  };
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => cell(c === 'ts' ? new Date(r.ts).toISOString() : r[c])).join(','))].join('\r\n');
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: `mailbench-activity-${Date.now()}.csv` });
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`Exported ${rows.length} rows`, 'success', 2000);
};
function paintFilter() {
  for (const b of $$('#log-filter button')) {
    const on = b.dataset.f === state.filter;
    b.className = `cursor-pointer rounded-md px-2.5 py-1 ${on ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'}`;
    b.setAttribute('aria-pressed', String(on));
  }
}

/* ---------------------------------------------------------- dialogs/token */
for (const d of $$('dialog')) {
  d.addEventListener('click', (e) => (e.target === d || e.target.closest('[data-close]')) && d.close());
}
function askToken() {
  $('#key-err').classList.add('hidden');
  const d = $('#dlg-key');
  if (!d.open) d.showModal();
  $('#key-input').focus();
}
$('#btn-key').onclick = askToken;
$('#key-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  setToken($('#key-input').value.trim());
  $('#key-input').value = '';
  try {
    await api('/status');
    $('#dlg-key').close();
    renderBanner(state.status, null);
    refresh(true);
  } catch (err) {
    if (err.status === 401) {
      setToken('');
      $('#key-err').classList.remove('hidden');
      e.preventDefault?.();
      $('#dlg-key').showModal?.();
    } else toast(err.message, 'error');
  }
});

/* ------------------------------------------------------------ diagnostics */
async function runDiagnostics() {
  const body = $('#diag-body');
  const dlg = $('#dlg-diag');
  if (!dlg.open) dlg.showModal();
  body.innerHTML = `<p class="flex items-center gap-2 text-zinc-500">${icon('loader-circle', 'spin')} Running checks...</p>`;
  paint();
  try {
    const r = await api('/diagnostics', { method: 'POST', timeout: 40_000 });
    body.innerHTML = r.checks
      .map(
        (c) => `<div class="flex items-start gap-2.5 rounded-lg border px-3 py-2 ${c.ok ? 'border-emerald-500/25 bg-emerald-500/5' : 'border-rose-500/30 bg-rose-500/10'}">
          ${icon(c.ok ? 'circle-check' : 'circle-x', `mt-0.5 text-base ${c.ok ? 'text-emerald-500' : 'text-rose-500'}`)}
          <div class="min-w-0 flex-1"><div class="font-medium">${esc(c.name)} ${c.ms != null ? `<span class="ml-1 font-mono text-xs font-normal text-zinc-500">${c.ms}ms</span>` : ''}</div><p class="break-words text-xs text-zinc-600 dark:text-zinc-400">${esc(c.detail)}</p></div></div>`
      )
      .join('');
  } catch (err) {
    if (err.status === 401) {
      dlg.close();
      return askToken();
    }
    body.innerHTML = `<p class="text-rose-500">${esc(err.message)}</p>`;
  }
  paint();
}
$('#btn-diag').onclick = runDiagnostics;
$('#btn-diag-run').onclick = runDiagnostics;

/* ------------------------------------------------------------ setup guide */
function openSetup() {
  const s = state.status;
  const body = $('#setup-body');
  const r = s?.redis;
  const row = (ok, title, detail) => `<li class="flex items-start gap-2.5">${icon(ok ? 'circle-check' : 'circle-dashed', `mt-0.5 text-base ${ok ? 'text-emerald-500' : 'text-amber-500'}`)}<div class="min-w-0"><div class="font-medium">${title}</div><div class="subtle break-words text-xs">${detail}</div></div></li>`;
  const ej = s?.providers.find((p) => p.id === 'emailjs');
  const rs = s?.providers.find((p) => p.id === 'resend');
  const env = 'REDIS_URL=rediss://default:YOUR_PASSWORD@YOUR-DB.upstash.io:6379\nRESEND_API_KEY=re_xxxxxxxx\nENABLE_SIMULATOR=true\nACCESS_TOKEN=pick-a-long-random-string';
  body.innerHTML = `
    <ul class="space-y-3">
      ${row(r?.status === 'ready', 'Redis / Upstash (Queued mode)', r?.status === 'ready' ? `Connected to ${esc(r.host || '')}${r.tls ? ' over TLS' : ''}.` : `Use the TCP endpoint from Upstash (console, your DB, Connect, ioredis), not the https REST URL. ${r?.error ? esc(r.error) : ''}`)}
      ${row(!!rs?.configured, 'Resend', rs?.configured ? 'API key found.' : 'Create a key at resend.com/api-keys and set RESEND_API_KEY. Without a verified domain you can only send from onboarding@resend.dev to your own account email.')}
      ${row(!!ej?.configured, 'EmailJS', ej?.configured ? 'Service, template and keys found.' : 'Set EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, EMAILJS_PUBLIC_KEY and EMAILJS_PRIVATE_KEY. In Account, Security, enable API calls from non-browser applications.')}
      ${row(!!s?.limits.simulator, 'Simulators', s?.limits.simulator ? 'Enabled: Sim Fast and Sim Slow need no keys.' : 'Set ENABLE_SIMULATOR=true for free fake providers.')}
    </ul>
    <div>
      <div class="mb-1.5 flex items-center justify-between"><span class="label !mb-0">Minimal .env</span><button type="button" id="btn-copy-env" class="chip">copy</button></div>
      <pre class="well overflow-x-auto p-3 font-mono text-xs leading-relaxed">${esc(env)}</pre>
    </div>
    <p class="subtle text-xs">Percent-encode special characters in the Redis password (@ becomes %40). Press the stethoscope icon afterwards to verify every connection without sending mail.</p>`;
  $('#btn-copy-env').onclick = async (e) => {
    try {
      await navigator.clipboard.writeText(env);
      e.currentTarget.textContent = 'copied';
      setTimeout(() => (e.currentTarget.textContent = 'copy'), 1500);
    } catch {
      toast('Clipboard blocked by the browser.', 'error');
    }
  };
  paint();
  $('#dlg-setup').showModal();
}
$('#btn-setup').onclick = openSetup;
$('#btn-setup-diag').onclick = () => ($('#dlg-setup').close(), runDiagnostics());

/* -------------------------------------------------------- A/B benchmark */
const sleep = (n) => new Promise((r) => setTimeout(r, n));

async function runBench() {
  if (state.benching || state.sending || !validate()) return;
  const s = state.status;
  if (!s?.queueAvailable) return toast('The benchmark needs Queued mode (working Redis).', 'warn');
  if (queuePending(s) > 0) return toast('Queues are still busy. Wait for them to drain (or Clear waiting) so the comparison is clean.', 'warn', 6000);
  const count = +$('#f-count').value;
  if (count < 2) return toast('Raise the burst size to 5 or more for a meaningful comparison.', 'warn');
  const live = selectedProviders().some((p) => p.kind === 'live');
  if (live && !confirm(`This sends ${count * 2} real emails (${count} per mode) and uses free-tier quota. Continue?`)) return;

  const dlg = $('#dlg-bench');
  const out = $('#bench-body');
  const step = (html) => ((out.innerHTML = html), paint());
  const spin = (t) => `<p class="flex items-center gap-2">${icon('loader-circle', 'spin')} ${t}</p>`;
  state.benching = true;
  state.fastUntil = Date.now() + 120_000;
  $('#btn-bench').disabled = true;
  dlg.showModal();
  try {
    step(spin(`Direct: sending ${count} emails at once...`));
    const t0 = performance.now();
    const d = await api('/send', { method: 'POST', body: { ...buildBody(), mode: 'direct' }, timeout: 120_000 });
    const directMs = performance.now() - t0;

    step(spin(`Queued: waiting for ${count} emails to drain...`));
    const base = await api('/status', { timeout: 15_000 });
    const s0 = sum(base, 'queued', 'sent');
    const f0 = sum(base, 'queued', 'failed');
    const t1 = performance.now();
    const q = await api('/send', { method: 'POST', body: { ...buildBody(), mode: 'queued' }, timeout: 60_000 });
    let cur = base;
    let drained = false;
    for (let i = 0; i < 240 && !drained; i++) {
      await sleep(1000);
      cur = await api('/status', { timeout: 15_000 });
      state.status = cur;
      renderModePanels(cur);
      renderProviders(cur);
      drained = queuePending(cur) === 0 && sum(cur, 'queued', 'sent') + sum(cur, 'queued', 'failed') - s0 - f0 >= q.accepted;
    }
    const queuedMs = performance.now() - t1;
    const qSent = sum(cur, 'queued', 'sent') - s0;
    const qFail = sum(cur, 'queued', 'failed') - f0;

    const card = (title, ic, sent, failed, time, note) => `<div class="well p-4"><div class="mb-3 flex items-center gap-2 font-semibold">${icon(ic, 'text-emerald-500')} ${title}</div>
      <div class="stat-num">${(time / 1000).toFixed(1)}<span class="subtle text-sm font-normal"> s</span></div>
      <div class="subtle mt-1 text-xs">wall time</div>
      <dl class="mt-3 grid grid-cols-2 gap-y-1 text-xs"><dt class="subtle">Delivered</dt><dd class="text-right font-mono text-emerald-500">${sent}</dd><dt class="subtle">Failed</dt><dd class="text-right font-mono ${failed ? 'text-rose-500' : ''}">${failed}</dd></dl>
      <p class="subtle mt-3 text-xs">${note}</p></div>`;
    step(`<div class="grid gap-3 sm:grid-cols-2">
      ${card('Direct', 'zap', d.sent, d.failed, directMs, 'One request, no throttling, no retries. Failures are final.')}
      ${card('Queued', 'layers', qSent, qFail, queuedMs, `Rate-limited per provider, retried with backoff, load-balanced. ${esc(q.summary || '')}`)}
    </div>
    <p class="subtle mt-3 text-xs">${drained ? 'Queued finished draining.' : 'Stopped waiting after 4 minutes; jobs may still be processing.'} Queued is usually slower end to end because it respects each provider's rate limit, but it recovers from 429s and transient errors instead of dropping the email.</p>`);
  } catch (err) {
    if (err.status === 401) {
      dlg.close();
      askToken();
    } else step(`<p class="flex items-start gap-2 text-rose-500">${icon('circle-x', 'mt-0.5')} ${esc(err.message)}</p>`);
  } finally {
    state.benching = false;
    $('#btn-bench').disabled = false;
    refresh();
  }
}
$('#btn-bench').onclick = runBench;

/* ------------------------------------------------------------------ polling */
// Every status read costs Redis commands (Upstash bills per command), so poll fast only while work is in progress.
function nextDelay() {
  const s = state.status;
  if (document.hidden) return 30_000;
  if (Date.now() < state.fastUntil) return 1000;
  if (s && (queuePending(s) > 0 || directPending(s) > 0)) return 1500;
  return 6000;
}

async function refresh(manual = false) {
  if (state.fetching) return;
  state.fetching = true;
  const btn = $('#btn-refresh');
  if (manual) btn.firstElementChild?.classList.add('spin');
  try {
    const s = await api('/status', { timeout: 15_000 });
    state.status = s;
    renderHeader(s);
    renderBanner(s, null);
    renderProviderChoices(s);
    renderModePanels(s);
    renderProviders(s);
    renderDistribution(s);
    renderLog(s, state.filter, state.query);
    syncControls();
    paintMode();
  } catch (err) {
    if (err.status === 401) {
      renderBanner(state.status, 'This deployment requires an access token.');
      if (!$('#dlg-key').open) askToken();
    } else {
      renderBanner(state.status, `Cannot load status: ${err.message}`);
    }
  } finally {
    state.fetching = false;
    btn.firstElementChild?.classList.remove('spin');
  }
}

function loop() {
  clearTimeout(state.timer);
  if (!state.live) return;
  state.timer = setTimeout(async () => {
    await refresh();
    loop();
  }, nextDelay());
}

$('#btn-live').onclick = (e) => {
  state.live = !state.live;
  e.currentTarget.setAttribute('aria-pressed', String(state.live));
  e.currentTarget.classList.toggle('!border-emerald-500', state.live);
  e.currentTarget.classList.toggle('!text-emerald-500', state.live);
  toast(state.live ? 'Live updates on' : 'Live updates paused', 'info', 1800);
  loop();
};
document.addEventListener('visibilitychange', () => !document.hidden && (refresh(), loop()));

/* --------------------------------------------------------------------- boot */
$('#btn-live').classList.add('!border-emerald-500', '!text-emerald-500');
$('#btn-theme').innerHTML = icon(document.documentElement.classList.contains('dark') ? 'sun' : 'moon');
paintView();
paintFilter();
paintMode();
paint();
refresh().then(loop);
