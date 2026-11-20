// Error taxonomy shared by providers, the queue worker and the API.
const RETRYABLE = new Set(['rate_limit', 'server', 'network', 'timeout']);

/** A failure coming from an email provider. `kind` drives retry / back-off behaviour. */
export class ProviderError extends Error {
  constructor(message, { kind = 'server', status, retryAfterMs, retryable } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.retryable = retryable ?? RETRYABLE.has(kind);
  }
}

export function toProviderError(err) {
  if (err instanceof ProviderError) return err;
  return new ProviderError(err?.message || String(err), { kind: 'server', retryable: true });
}

/** An error that maps to an HTTP status in the API. */
export class HttpError extends Error {
  constructor(status, message, field) {
    super(message);
    this.status = status;
    this.field = field;
  }
}
