export const UA = 'Mozilla/5.0 (compatible; studio-news-hype/0.1; +open-sources-only)';

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status}`);
    this.status = status;
    this.url = url;
  }
}

/** GET одним запросом. Не 2xx — HttpError со статусом (429 обрабатывает вызывающий). */
export async function getText(url, { fetchImpl = fetch, timeoutMs = 15000, headers = {} } = {}) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': UA, ...headers } });
  if (!res.ok) throw new HttpError(res.status, url);
  return res.text();
}

export const getJson = async (url, opts) => JSON.parse(await getText(url, { ...opts, headers: { accept: 'application/json', ...opts?.headers } }));

export const pause = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export const iso = (t) => {
  const n = typeof t === 'number' ? t : Date.parse(t ?? '');
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
};

/** «2K+», «1,5M+», «100+» → число. */
export function parseTraffic(s) {
  const m = String(s ?? '').replace(/\s/g, '').match(/^([\d.,]+)([KkКкMmМмBb]?)/);
  if (!m) return 0;
  const n = Number(m[1].replace(',', '.'));
  const mult = { k: 1e3, к: 1e3, m: 1e6, м: 1e6, b: 1e9 }[m[2].toLowerCase()] ?? 1;
  return Number.isFinite(n) ? Math.round(n * mult) : 0;
}
