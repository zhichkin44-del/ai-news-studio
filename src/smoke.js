import { fileURLToPath } from 'node:url';
import { fetchFeed, loadSources } from './collect.js';

const FRESH_MS = 6 * 3600 * 1000;
const SLOW_MS = 48 * 3600 * 1000; // редкие ленты (ООН выходит раз в сутки): окно свежести 48 часов

/** Живой проход по лентам (в базу ничего не пишет). ok = нет ошибок и у каждой ленты есть запись младше 6 часов. */
export async function smoke(sources, { loader = fetchFeed, now = Date.now() } = {}) {
  const results = await Promise.allSettled(sources.map((s) => loader(s)));
  const rows = results.map((r, i) => {
    const id = sources[i].id;
    if (r.status === 'rejected') return { source: id, count: 0, newest: null, ageMin: null, error: String(r.reason?.message ?? r.reason), ok: false };
    const times = r.value.map((x) => Date.parse(x.published)).filter(Number.isFinite);
    const newest = times.length ? Math.max(...times) : null;
    const fresh = times.filter((t) => now - t < (sources[i].slow ? SLOW_MS : FRESH_MS)).length;
    return { source: id, count: r.value.length, newest: newest && new Date(newest).toISOString(), ageMin: newest && Math.max(0, Math.round((now - newest) / 60000)), error: null, ok: fresh > 0 };
  });
  return { rows, ok: rows.every((r) => r.ok) };
}

const age = (m) => (m == null ? '—' : m < 120 ? `${m} мин` : `${(m / 60).toFixed(1)} ч`);

export function formatSmoke({ rows }) {
  return ['лента | записей | самая свежая | возраст', ...rows.map((r) => `${r.source} | ${r.count} | ${r.newest ?? '—'} | ${r.error ? `ОШИБКА: ${r.error}` : age(r.ageMin) + (r.ok ? '' : ' (нет записей младше 6 ч)')}`)].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const res = await smoke(await loadSources());
  console.log(formatSmoke(res));
  process.exit(res.ok ? 0 : 1);
}
