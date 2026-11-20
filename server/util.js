export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Bookkeeping must never break the main flow (e.g. never turn a delivered email into a retry). */
export async function safe(fn, label = 'bookkeeping') {
  try {
    return await fn();
  } catch (err) {
    console.error(`[${label}] ${err?.message || err}`);
    return undefined;
  }
}

export const maskHost = (h) => (h && h.length > 12 ? `${h.slice(0, 6)}...${h.slice(-14)}` : h);
