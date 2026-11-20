// Thin fetch wrapper: access token, JSON errors, timeouts.
const KEY = 'mb-token';
export const getToken = () => sessionStorage.getItem(KEY) || '';
export const setToken = (t) => (t ? sessionStorage.setItem(KEY, t) : sessionStorage.removeItem(KEY));

export class ApiError extends Error {
  constructor(message, status, body = {}) {
    super(message);
    this.status = status;
    this.field = body.field;
    this.code = body.code;
    this.body = body;
  }
}

export async function api(path, { method = 'GET', body, timeout = 60_000 } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout) });
  } catch (e) {
    throw new ApiError(e.name === 'TimeoutError' ? 'Request timed out' : 'Cannot reach the server', 0);
  }
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* non-JSON error page */
  }
  // 502 on /send means "every email failed", the body still carries per-email results
  if (!res.ok && !(path === '/send' && res.status === 502 && data.results)) {
    throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data);
  }
  return data;
}
