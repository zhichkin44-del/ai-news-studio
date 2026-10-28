import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cluster } from './select.js';
import { loadSources } from './collect.js';
import { openStore, DEFAULT_DB } from './store.js';

export const OUT_PATH = 'docs/eval/metrics-latest.json';
export const FAST_MS = 5 * 60 * 1000;
export const FRESH_MS = 6 * 3600 * 1000;

const round = (x, d = 3) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
const share = (n, d) => (d ? round(n / d) : null);

/** Перцентиль по ближайшему рангу; пустой набор — null. */
export function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

/** Задержка, мс: first_seen − published. Только записи не из первого опроса ленты (baseline) и с датой публикации. */
function latencies(items) {
  return items
    .filter((i) => !i.baseline && i.published)
    .map((i) => Math.max(0, Date.parse(i.first_seen) - Date.parse(i.published)))
    .filter(Number.isFinite);
}

function latencyStats(items) {
  const l = latencies(items);
  return {
    measured: l.length,
    median_sec: l.length ? round(percentile(l, 50) / 1000, 1) : null,
    p90_sec: l.length ? round(percentile(l, 90) / 1000, 1) : null,
    within_5min: share(l.filter((x) => x <= FAST_MS).length, l.length),
  };
}

/** Метрики сбора за последние `hours` часов по базе. */
export function computeMetrics(store, { now = new Date(), hours = 24, sources = [], groups = {} } = {}) {
  const since = new Date(now.getTime() - hours * 3600e3).toISOString();
  const freshSince = now.getTime() - FRESH_MS;
  const items = store.itemsSince(since);
  const polls = store.pollsSince(since);

  const clusters = items.length ? cluster(items, 0.4, groups) : [];
  const multi = clusters.filter((c) => c.sourceCount >= 2).length;

  const ids = [...new Set([...sources.map((s) => s.id), ...items.map((i) => i.source), ...polls.map((p) => p.source)])];
  const feeds = ids.map((id) => {
    const its = items.filter((i) => i.source === id);
    const ps = polls.filter((p) => p.source === id);
    const errors = ps.filter((p) => !p.ok).length;
    const times = its.map((i) => Date.parse(i.published ?? i.first_seen)).filter(Number.isFinite);
    const newest = times.length ? Math.max(...times) : null;
    const fresh = times.filter((t) => t >= freshSince).length;
    return {
      source: id,
      items: its.length,
      polls: ps.length,
      errors,
      error_rate: share(errors, ps.length),
      newest: newest ? new Date(newest).toISOString() : null,
      fresh_6h: fresh,
      problem: errors > 0 ? 'ошибки' : fresh === 0 ? 'нет свежих за 6 ч' : null,
      latency: latencyStats(its),
    };
  });

  const distinctLinks = new Set(items.map((i) => i.link)).size;
  return {
    generated_at: now.toISOString(),
    period_hours: hours,
    since,
    items: items.length,
    events: clusters.length,
    events_by_feed: Object.fromEntries(feeds.map((f) => [f.source, clusters.filter((c) => c.items.some((i) => i.source === f.source)).length])),
    latency: latencyStats(items),
    multi_source_share: share(multi, clusters.length),
    duplicates_merged_share: share(items.length - clusters.length, items.length),
    unique_items_share: share(distinctLinks, items.length),
    problem_feeds: feeds.filter((f) => f.problem).map((f) => ({ source: f.source, problem: f.problem, errors: f.errors, fresh_6h: f.fresh_6h })),
    feeds,
  };
}

const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)} %`);
const sec = (x) => (x == null ? '—' : `${x} с`);

export function formatMetrics(m) {
  const lines = [
    `Метрики сбора за ${m.period_hours} ч (с ${m.since})`,
    `Записей: ${m.items}; событий (кластеров): ${m.events}`,
    `Задержка (first_seen − published, без первого опроса ленты): медиана ${sec(m.latency.median_sec)}, p90 ${sec(m.latency.p90_sec)}, не позже 5 мин: ${pct(m.latency.within_5min)} (замерено ${m.latency.measured})`,
    `События с 2+ независимыми источниками: ${pct(m.multi_source_share)}`,
    `Дублей склеено в кластеры: ${pct(m.duplicates_merged_share)}; записей без повторов: ${pct(m.unique_items_share)}`,
    '',
    'лента | записей | событий | опросов | ошибок | свежих 6ч | медиана | ≤5 мин',
    ...m.feeds.map((f) => [f.source, f.items, m.events_by_feed[f.source], f.polls, f.errors, f.fresh_6h, sec(f.latency.median_sec), pct(f.latency.within_5min)].join(' | ')),
    '',
    m.problem_feeds.length ? `Проблемные ленты: ${m.problem_feeds.map((f) => `${f.source} (${f.problem})`).join(', ')}` : 'Проблемных лент нет',
  ];
  return lines.join('\n');
}

export function parseArgs(argv) {
  const out = { hours: 24, db: DEFAULT_DB };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--hours') {
      out.hours = Number(argv[++i]);
      if (!(out.hours > 0)) throw new Error('--hours требует число > 0');
    } else if (argv[i] === '--db') out.db = argv[++i];
    else throw new Error(`неизвестный флаг: ${argv[i]}`);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const sources = await loadSources();
  const store = openStore(args.db);
  try {
    const m = computeMetrics(store, { hours: args.hours, sources, groups: Object.fromEntries(sources.map((s) => [s.id, s.group ?? s.id])) });
    mkdirSync(dirname(OUT_PATH), { recursive: true });
    writeFileSync(OUT_PATH, JSON.stringify(m, null, 2) + '\n', 'utf8');
    console.log(formatMetrics(m));
    console.log(`\nЗаписано: ${OUT_PATH}`);
  } finally {
    store.close();
  }
}
