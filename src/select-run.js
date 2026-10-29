import { fileURLToPath } from 'node:url';
import { cluster } from './cluster.js';
import { loadSources } from './collect.js';
import { decide, clusterId, firstSeenOf, eventMeta, sourceMetaOf } from './issue.js';
import { DEFAULT_CONFIG, isBreaking } from './score.js';
import { POLITICS, pickDiverse, peakOf, sectionOf, sectionFor } from './diversity.js';
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
 * Топ дня: события с оценкой ≥ min (кроме отклонённых воротами), до perDay за календарный день,
 * с миксом: не больше perGroup одной группы и минимум minOutside вне политики, если такое есть.
 * events: [{ id, score, peak_score, section, category, first_seen, status }]. Возвращает Set id.
 */
export function topOfDay(events, {
  min = 40, perDay = 7, tzHours = 7, perGroup = 2, minOutside = 3, politics = POLITICS, relax = 0,
} = {}) {
  const byDay = new Map();
  for (const e of events) {
    const day = ownerDay(e.first_seen, tzHours);
    // не политика/война проходит с пониженным порогом (relax): квота не добивается войной
    const floor = sectionOf(e) === politics ? min : min - relax;
    if (!day || e.status === 'отклонено' || !(peakOf(e) >= floor)) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(e);
  }
  const top = new Set();
  for (const list of byDay.values()) {
    for (const e of pickDiverse(list, { limit: perDay, perGroup, minOutside, minScore: min, politics, strict: true })) top.add(e.id);
  }
  return top;
}

/**
 * По одной последней записи на издателя (groups сводит ленты одного издателя).
 * event_sources копит ссылки за все прогоны, поэтому для «срочного» нельзя считать их все.
 */
export function latestPerPublisher(sources, groups = {}) {
  const latest = new Map();
  for (const s of sources) {
    const key = groups[s.source] ?? s.source;
    const prev = latest.get(key);
    if (!prev || String(s.published ?? '') > String(prev.published ?? '')) latest.set(key, s);
  }
  return [...latest.values()];
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
  const out = { items: items.length, events: 0, selected: 0, rejected: 0, fresh: 0, breaking: 0 };
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
    const srcCat = eventMeta(c, sourceMeta).category;
    // лента науки/техники/космоса/медицины держит категорию ленты; остальным — категория темы аудитории
    store.setCategory(r.id, ['science', 'space', 'health', 'tech'].includes(srcCat) ? srcCat : d.sc.audienceCategory ?? srcCat);
    // группа разнообразия: шоковый класс, затем тема аудитории, затем категория ленты
    // (у общих ru-лент категория russia — она не должна перебивать тему «экономика», «наука» и т. п.)
    const section = sectionFor({ shockGroup: d.sc.shockGroup, audienceCategory: d.sc.audienceCategory, feedCategory: srcCat });
    store.setSection(r.id, section);
    out.events++;
    let [status, reason] = selectStatus(c, d);
    // высокий пик не теряем из-за старения текущей оценки: топ и дайджест считают по peak_score
    const peak = store.get(r.id)?.peak_score ?? 0;
    if (status === 'отклонено' && d.gate.ok && peak >= (cfg.thresholds?.publish ?? 40)) {
      status = 'новое';
      reason = `оценка снизилась до ${d.sc.score}, пик ${peak}`;
    }
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
  const tz = cfg.owner_feed_tz_hours ?? 7;
  const div = cfg.diversity ?? {};
  const perGroup = div.per_group ?? 2;
  const minOutside = div.min_outside_politics ?? 3;
  const politics = div.politics ?? POLITICS;
  const days = new Set([...seen].map((id) => ownerDay(store.get(id).first_seen, tz)).filter(Boolean));

  // «Отобрано» 15–30 в сутки: лишнее сверх дневного потолка уходит в «отклонено» по пиковой оценке
  let all = store.list();
  const maxSelected = cfg.daily_selected_max ?? 0;
  if (maxSelected > 0) {
    let demoted = 0;
    for (const day of days) {
      const selected = all.filter((e) => ownerDay(e.first_seen, tz) === day && e.status === 'отобрано' && !store.hasDraft(e.id));
      if (selected.length <= maxSelected) continue;
      const sorted = [...selected].sort((a, b) => peakOf(b) - peakOf(a) || String(a.first_seen ?? '').localeCompare(String(b.first_seen ?? '')) || String(a.id).localeCompare(String(b.id)));
      for (const e of sorted.slice(maxSelected)) {
        store.setStatus(e.id, 'отклонено', `дневной лимит ${maxSelected}`, stamp);
        demoted++;
      }
    }
    out.selected -= demoted;
    out.rejected += demoted;
  }
  all = store.list();
  const inDays = all.filter((e) => days.has(ownerDay(e.first_seen, tz)));

  // Срочное: то же правило микса — до per_day за сутки, не больше per_group одной группы
  const minBreakingSources = cfg.breaking?.min_sources ?? 2;
  const breaking = pickDiverse(
    inDays.filter((e) => {
      if (e.status === 'отклонено' || Number(e.independent_sources ?? 0) < minBreakingSources) return false;
      // в базе копятся все ссылки за все прогоны: считаем по одной последней на издателя
      const publishers = latestPerPublisher(e.sources, groups);
      return isBreaking(peakOf(e), publishers, { now: now.getTime(), config: cfg });
    }),
    { limit: cfg.breaking?.per_day ?? 7, perGroup: cfg.breaking?.per_group ?? perGroup, minOutside, minScore: cfg.breaking?.min_score ?? 70, politics },
  );
  store.setBreakingFlags(breaking.map((e) => e.id), inDays.map((e) => e.id));
  out.breaking = breaking.length;

  // «Топ дня» — только текущие сутки UTC+7; пометки прошлых дней сбрасываются (была ошибка «42 топа»)
  const nowDay = ownerDay(now.toISOString(), tz);
  const dayEvents = nowDay ? all.filter((e) => ownerDay(e.first_seen, tz) === nowDay) : [];
  const top = topOfDay(dayEvents, {
    min: cfg.owner_feed_min ?? 40, perDay: cfg.owner_feed_top_per_day ?? 7, tzHours: tz,
    perGroup, minOutside, politics, relax: div.relax_points ?? 0,
  });
  store.setTopOfDay(top, all.map((e) => e.id));
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
    console.log(`записей ${r.items}, событий ${r.events}, отобрано ${r.selected}, отклонено ${r.rejected}, в топе дня ${r.top}, срочных ${r.breaking}`);
  } finally {
    store.close();
  }
}
