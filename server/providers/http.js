import { ProviderError } from '../errors.js';

/** fetch wrapper that converts transport failures into typed ProviderErrors. */
export async function request(url, { method = 'POST', headers = {}, body, timeoutMs = 20_000 } = {}) {
  let res;
  try {
    res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new ProviderError(`request timed out after ${timeoutMs}ms`, { kind: 'timeout' });
    }
    throw new ProviderError(`network error: ${err?.cause?.code || err?.message || err}`, { kind: 'network' });
  }
  const text = await res.text().catch(() => '');
  return { status: res.status, headers: res.headers, text };
}

export function retryAfterMs(headers) {
  const v = headers.get('retry-after');
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.round(secs * 1000);
  const date = Date.parse(v);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export function kindFromStatus(status) {
  if (status === 429) return 'rate_limit';
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 402) return 'quota';
  if (status === 408) return 'timeout';
  if (status >= 500) return 'server';
  return 'invalid';
}

export const trim = (s, n = 300) => (s.length > n ? `${s.slice(0, n)}...` : s);
