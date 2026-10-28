import { fileURLToPath } from 'node:url';
import { cluster } from './cluster.js';
import { loadSources } from './collect.js';
import { decide, clusterId, firstSeenOf, eventMeta, sourceMetaOf } from './issue.js';
import { DEFAULT_CONFIG } from './score.js';
import { openStore, DEFAULT_DB } from './store.js';

/** Статус по решению decide: отобрано / отклонено (ворота) / новое (ниже порога, один источник — может подрасти). */
export function selectStatus(c, d) {
  if (d.status !== 'отклонено') return ['отобрано', d.reason ?? (d.sc.single ? 'одно-источниковое: ждёт одобрения владельца' : null)];
  if (d.gate.ok && c.sourceCount < 2) return ['новое', d.reason];
  return ['отклонено', d.reason];
}

/** Календарный день first_seen по времени владельца (UTC+tz), 'YYYY-MM-DD'; null, если времени нет. */
export function ownerDay(firstSeen, tzHours = 7) {
  const t = Date.parse(firstSeen ?? '');
  return Number.isNaN(t) ? null : new Date(t + tzHours * 3.6e6).toISOString().slice(0, 10);
}

/**
 * Топ дня: события с оценкой ≥ min (кроме отклонённых воротами), лучшие perDay за календарный день.
 * events: [{ id, score, first_seen, status }]. Возвращает Set id.
 */
export function topOfDay(events, { min = 40, perDay = 5, tzHours = 7 } = {}) {
  const byDay = new Map();
  for (const e of events) {
    const day = ownerDay(e.first_seen, tzHours);
    if (!day || e.status === 'отклонено' || !(e.score >= min)) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(e);
  }
  const top = new Set();
  for (const list of byDay.values()) {
    list.sort((a, b) => b.score - a.score || (a.first_seen < b.first_seen ? -1 : a.first_seen > b.first_seen ? 1 : 0) || (a.id < b.id ? -1 : 1));
    list.slice(0, perDay).forEach((e) => top.add(e.id));
  }
  return top;
}

/**
 * Записи items за последние `hours` часов → кластеры → оценка → события в базе.
 * Выпущенное и событие с черновиком не трогаем (статус не сбрасывается). Постов и файлов не пишем.
 */
export function selectEvents(store, { hours = 24, now = new Date(), groups = {}, names = {}, sourceMeta = {}, scoreConfig } = {}) {
  const cfg = scoreConfig ?? DEFAULT_CONFIG;
  const since = new Date(now.getTime() - hours * 3.6e6).toISOString();
  const items = store.itemsSince(since).map((r) => ({ id: r.id, source: r.source, title: r.title, summary: r.summary ?? '', link: r.link, published: r.published }));
  const clusters = cluster(items, undefined, groups);
  const stamp = now.toISOString();
  const seen = new Set();
  const out = { items: items.length, events: 0, selected: 0, rejected: 0, fresh: 0 };
  for (const c of clusters) {
    const d = decide(c, { now: now.getTime(), scoreConfig: cfg, sourceMeta });
    const r = store.upsert(
      {
        id: clusterId(c), title: c.title, firstSeen: firstSeenOf(c), independentSources: c.sourceCount, score: d.sc.score, reasons: d.sc.reasons, needsOwner: d.sc.needsOwner,
        sources: c.sources.map((s) => ({ source: s.source, name: names[s.source] ?? s.source, link: s.link, published: s.published })),
      },
      stamp,
    );
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    store.setCategory(r.id, eventMeta(c, sourceMeta).category);
    out.events++;
    let [status, reason] = selectStatus(c, d);
    if (r.status === 'выпущено' || store.hasDraft(r.id)) {
      status = r.status; // уже выпущено/с черновиком: статус не сбрасываем
      reason = store.get(r.id).status_reason;
    } else {
      store.setStatus(r.id, status, reason, stamp);
    }
    if (status === 'отобрано') out.selected++;
    else if (status === 'отклонено') out.rejected++;
    else if (status === 'новое') out.fresh++;
  }
  // лента владельца: топ дня пересчитываем по всем событиям тех суток, которых коснулись
  const tz = cfg.owner_feed_tz_hours ?? 7;
  const days = new Set([...seen].map((id) => ownerDay(store.get(id).first_seen, tz)).filter(Boolean));
  const scope = store.list().filter((e) => days.has(ownerDay(e.first_seen, tz)));
  const top = topOfDay(scope, { min: cfg.owner_feed_min ?? 40, perDay: cfg.owner_feed_top_per_day ?? 5, tzHours: tz });
  store.setTopOfDay(top, scope.map((e) => e.id));
  out.top = top.size;
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--hours');
  const hours = i >= 0 ? Number(args[i + 1]) : 24;
  if (!(hours > 0)) {
    console.error('Использование: npm run select -- [--hours N]');
    process.exit(2);
  }
  const sources = await loadSources();
  const store = openStore(process.env.NEWS_DB ?? DEFAULT_DB);
  try {
    const r = selectEvents(store, {
      hours,
      groups: Object.fromEntries(sources.map((s) => [s.id, s.group ?? s.id])),
      names: Object.fromEntries(sources.map((s) => [s.id, s.name])),
      sourceMeta: sourceMetaOf(sources),
    });
    console.log(`записей ${r.items}, событий ${r.events}, отобрано ${r.selected}, отклонено ${r.rejected}, в топе дня ${r.top}`);
  } finally {
    store.close();
  }
}
