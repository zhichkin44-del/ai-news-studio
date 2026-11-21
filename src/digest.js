import { fileURLToPath } from 'node:url';
import { openStore, DEFAULT_DB } from './store.js';
import { DEFAULT_CONFIG } from './score.js';
import { POLITICS, pickDiverse, peakOf } from './diversity.js';

const TZ = 7; // часовой пояс владельца, UTC+7
const HOUR = 3.6e6;

/** Время из флага: ISO с зоной (Z, +03:00) как есть; без зоны — по UTC+7. NaN, если не время. */
export function parseLocal(s) {
  const str = String(s ?? '').trim();
  return Date.parse(/(Z|[+-]\d\d:?\d\d)$/i.test(str) ? str : `${str}${str.length <= 10 ? 'T00:00:00' : ''}+0${TZ}:00`);
}

/** Последняя ночь 18:00→08:00 по UTC+7, уже закончившаяся к моменту now: { from, to } (Date). */
export function lastNight(now = new Date()) {
  const local = new Date(now.getTime() + TZ * HOUR); // «стенные» часы UTC+7 в полях UTC
  let to = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 8) - TZ * HOUR;
  if (to > now.getTime()) to -= 24 * HOUR;
  return { from: new Date(to - 14 * HOUR), to: new Date(to) };
}

/**
 * «Главное за ночь»: до `limit` лучших событий с first_seen в [from, to), без отклонённых.
 * Возвращает [{ id, title, score, category }] по убыванию оценки.
 */
export function digest(store, { from, to, limit = 7, config = DEFAULT_CONFIG } = {}) {
  const a = from.getTime();
  const b = to.getTime();
  const div = config.diversity ?? {};
  const rows = store
    .list()
    .filter((e) => e.status !== 'отклонено' && Date.parse(e.first_seen) >= a && Date.parse(e.first_seen) < b);
  return pickDiverse(rows, {
    limit, perGroup: div.per_group ?? 2, minOutside: div.min_outside_politics ?? 3,
    minScore: config.owner_feed_min ?? 40, politics: div.politics ?? POLITICS, strict: true, ceilings: div.ceilings,
  }).map((e) => ({ id: e.id, title: e.title, score: peakOf(e), category: e.category }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const arg = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const night = lastNight();
  const from = arg('--from') ? new Date(parseLocal(arg('--from'))) : night.from;
  const to = arg('--to') ? new Date(parseLocal(arg('--to'))) : night.to;
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    console.error('Usage: npm run digest -- [--from 2026-10-27T18:00] [--to 2026-10-28T08:00] [--limit 7]  (no zone: UTC+7)');
    process.exit(2);
  }
  const store = openStore(process.env.NEWS_DB ?? DEFAULT_DB);
  try {
    console.log(JSON.stringify(digest(store, { from, to, limit: Number(arg('--limit')) || 7 }), null, 2));
  } finally {
    store.close();
  }
}
