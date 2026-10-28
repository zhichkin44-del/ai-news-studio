import { fileURLToPath } from 'node:url';
import { cluster } from './cluster.js';
import { loadSources } from './collect.js';
import { decide, clusterId, firstSeenOf } from './issue.js';
import { openStore, DEFAULT_DB } from './store.js';

/** Статус по решению decide: отобрано / отклонено (ворота) / новое (ниже порога, один источник — может подрасти). */
export function selectStatus(c, d) {
  if (d.status !== 'отклонено') return ['отобрано', d.reason ?? (d.sc.single ? 'одно-источниковое: ждёт одобрения владельца' : null)];
  if (d.gate.ok && c.sourceCount < 2) return ['новое', d.reason];
  return ['отклонено', d.reason];
}

/**
 * Записи items за последние `hours` часов → кластеры → оценка → события в базе.
 * Выпущенное и событие с черновиком не трогаем (статус не сбрасывается). Постов и файлов не пишем.
 */
export function selectEvents(store, { hours = 24, now = new Date(), groups = {}, names = {}, scoreConfig } = {}) {
  const since = new Date(now.getTime() - hours * 3.6e6).toISOString();
  const items = store.itemsSince(since).map((r) => ({ id: r.id, source: r.source, title: r.title, summary: r.summary ?? '', link: r.link, published: r.published }));
  const clusters = cluster(items, undefined, groups);
  const stamp = now.toISOString();
  const seen = new Set();
  const out = { items: items.length, events: 0, selected: 0, rejected: 0, fresh: 0 };
  for (const c of clusters) {
    const d = decide(c, { now: now.getTime(), scoreConfig });
    const r = store.upsert(
      {
        id: clusterId(c), title: c.title, firstSeen: firstSeenOf(c), independentSources: c.sourceCount, score: d.sc.score, reasons: d.sc.reasons, needsOwner: d.sc.needsOwner,
        sources: c.sources.map((s) => ({ source: s.source, name: names[s.source] ?? s.source, link: s.link, published: s.published })),
      },
      stamp,
    );
    if (seen.has(r.id)) continue;
    seen.add(r.id);
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
    });
    console.log(`записей ${r.items}, событий ${r.events}, отобрано ${r.selected}, отклонено ${r.rejected}`);
  } finally {
    store.close();
  }
}
