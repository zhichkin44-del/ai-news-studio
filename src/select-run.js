import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cluster } from './cluster.js';
import { BURST_CONFIG, detectBursts, burstTitle, timeOf } from './hype/burst.js';
import { kindsOf } from './hype/index.js';
import { loadSources } from './collect.js';
import { decide, clusterId, firstSeenOf, eventMeta, sourceMetaOf } from './issue.js';
import { DEFAULT_CONFIG, isBreaking } from './score.js';
import { POLITICS, pickDiverse, peakOf, sectionOf, sectionFor } from './diversity.js';
import { openStore, DEFAULT_DB } from './store.js';

/** Status from the decide result: selected («отобрано») / rejected («отклонено», gate) / new («новое»: below threshold, single source — may still grow). */
export function selectStatus(c, d) {
  if (d.status !== 'отклонено') return ['отобрано', d.reason ?? (d.sc.single ? 'одно-источниковое: ждёт одобрения владельца' : null)];
  if (d.gate.ok && c.sourceCount < 2) return ['новое', d.reason];
  return ['отклонено', d.reason];
}

/** Calendar day of first_seen in the owner's time (UTC+tz), 'YYYY-MM-DD'; null if there is no time. */
export function ownerDay(firstSeen, tzHours = 7) {
  const t = Date.parse(firstSeen ?? '');
  return Number.isNaN(t) ? null : new Date(t + tzHours * 3.6e6).toISOString().slice(0, 10);
}

/**
 * Top of the day: events with score ≥ min (except those rejected by the gate), up to perDay per calendar day,
 * with a mix: no more than perGroup from one group and at least minOutside outside politics, if there are any.
 * events: [{ id, score, peak_score, section, category, first_seen, status }]. Returns a Set of ids.
 */
export function topOfDay(events, {
  min = 40, perDay = 7, tzHours = 7, perGroup = 2, minOutside = 3, politics = POLITICS, relax = 0, ceilings = null,
} = {}) {
  const byDay = new Map();
  for (const e of events) {
    const day = ownerDay(e.first_seen, tzHours);
    // non-politics/war passes at a lowered threshold (relax): the quota is not filled with war
    const floor = sectionOf(e) === politics ? min : min - relax;
    if (!day || e.status === 'отклонено' || !(peakOf(e) >= floor)) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(e);
  }
  const top = new Set();
  for (const list of byDay.values()) {
    for (const e of pickDiverse(list, { limit: perDay, perGroup, minOutside, minScore: min, politics, strict: true, ceilings })) top.add(e.id);
  }
  return top;
}

/**
 * One latest record per publisher (groups merges feeds of one publisher).
 * event_sources accumulates links across all runs, so for «срочное» (urgent) they cannot all be counted.
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
 * Spike → cluster for decide: the headline comes from media feeds (otherwise the strongest signal); the event's sources are all records of the spike
 * (links are stored only in the database). Independent sources = media publishers + signal kinds. Freshness and growth — over the last hour.
 */
export function burstCluster(b, { now = Date.now(), kinds = {}, groups = {}, config = BURST_CONFIG } = {}) {
  const recentFrom = now - config.recent_minutes * 60000;
  const recent = b.items.filter((i) => timeOf(i, now) > recentFrom);
  const toItem = (r) => ({ id: r.id, source: r.source, title: r.title, summary: r.summary ?? '', link: r.link, published: r.published });
  const publishers = new Set(b.mediaItems.map((i) => groups[i.source] ?? i.source));
  const signalKinds = new Set(b.signalItems.map((i) => kinds[i.source]));
  const items = (recent.length ? recent : b.items).map(toItem);
  return {
    id: createHash('sha1').update(`hype:${[...b.tokens].sort().join(' ')}:${new Date(now).toISOString().slice(0, 10)}`).digest('hex').slice(0, 12),
    title: burstTitle(b, config),
    items, sources: b.items.map(toItem),
    sourceCount: publishers.size + signalKinds.size,
    newest: items.map((i) => i.published).filter(Boolean).sort().at(-1) ?? null,
    status: 'подтверждено',
    hype: { types: b.types.length, ratio: b.ratio, tokens: b.tokens },
  };
}

/**
 * Items from the last `hours` hours → clusters → score → events in the database.
 * Published events and events with a draft are not touched (status is not reset). No posts or files are written.
 */
export function selectEvents(store, { hours = 24, now = new Date(), groups = {}, names = {}, sourceMeta = {}, scoreConfig, kinds = {}, burstConfig } = {}) {
  const cfg = scoreConfig ?? DEFAULT_CONFIG;
  const since = new Date(now.getTime() - hours * 3.6e6).toISOString();
  const rows = store.itemsSince(since);
  // hype signals (Reddit, Trends, …) are not news: only media feeds go into clusters
  const toItem = (r) => ({ id: r.id, source: r.source, title: r.title, summary: r.summary ?? '', link: r.link, published: r.published });
  const bursts = Object.keys(kinds).length ? detectBursts(rows, {
    now: now.getTime(), kinds, config: burstConfig,
    known: store.list().filter((e) => e.top_of_day && !e.hype).map((e) => e.title), // topic already in the top — not new
  }) : [];
  const inBurst = new Set(bursts.flatMap((b) => b.mediaItems.map((i) => i.id)));
  const items = rows.filter((r) => !kinds[r.source] && !inBurst.has(r.id)).map(toItem);
  const clusters = [...bursts.map((b) => burstCluster(b, { now: now.getTime(), kinds, groups, config: burstConfig })), ...cluster(items, undefined, groups)];
  const stamp = now.toISOString();
  const seen = new Set();
  const out = { items: items.length, events: 0, selected: 0, rejected: 0, fresh: 0, breaking: 0, hype: bursts.length };
  for (const c of clusters) {
    const d = decide(c, { now: now.getTime(), scoreConfig: cfg, sourceMeta });
    const r = store.upsert(
      {
        id: c.id ?? clusterId(c), hype: !!c.hype, title: c.title, firstSeen: firstSeenOf(c), independentSources: c.sourceCount, score: d.sc.score, reasons: d.sc.reasons, needsOwner: d.sc.needsOwner,
        sources: c.sources.map((s) => ({ source: s.source, name: names[s.source] ?? s.source, link: s.link, published: s.published })),
      },
      stamp,
    );
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const srcCat = eventMeta(c, sourceMeta).category;
    // science/tech/space/health feeds keep the feed's category; for the rest — the category of the audience topic
    store.setCategory(r.id, ['science', 'space', 'health', 'tech'].includes(srcCat) ? srcCat : d.sc.audienceCategory ?? srcCat);
    // diversity group: shock class, then the audience topic, then the feed category
    // (common ru feeds have the category russia — it must not override a topic such as «экономика» (economy), «наука» (science), etc.)
    const section = sectionFor({ shockGroup: d.sc.shockGroup, audienceCategory: d.sc.audienceCategory, feedCategory: srcCat });
    store.setSection(r.id, section);
    out.events++;
    let [status, reason] = selectStatus(c, d);
    // do not lose a high peak because the current score has aged: the top and digest count by peak_score
    const peak = store.get(r.id)?.peak_score ?? 0;
    if (status === 'отклонено' && d.gate.ok && peak >= (cfg.thresholds?.publish ?? 40)) {
      status = 'новое';
      reason = `оценка снизилась до ${d.sc.score}, пик ${peak}`;
    }
    if (r.status === 'выпущено' || store.hasDraft(r.id)) {
      status = r.status; // already published / has a draft: do not reset the status
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
  const days = new Set([...seen].map((id) => ownerDay(store.get(id)?.first_seen, tz)).filter(Boolean));

  // «Отобрано» (selected) 15–30 per day: the excess over the daily ceiling goes to «отклонено» (rejected) by peak score
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

  // Urgent: the same mix rule — up to per_day per day, no more than per_group from one group
  const minBreakingSources = cfg.breaking?.min_sources ?? 2;
  const breaking = pickDiverse(
    inDays.filter((e) => {
      if (e.status === 'отклонено' || Number(e.independent_sources ?? 0) < minBreakingSources) return false;
      // the database accumulates all links across all runs: count one latest per publisher
      const publishers = latestPerPublisher(e.sources, groups);
      return isBreaking(peakOf(e), publishers, { now: now.getTime(), config: cfg });
    }),
    { limit: cfg.breaking?.per_day ?? 7, perGroup: cfg.breaking?.per_group ?? perGroup, minOutside, minScore: cfg.breaking?.min_score ?? 70, politics },
  );
  store.setBreakingFlags(breaking.map((e) => e.id), inDays.map((e) => e.id));
  out.breaking = breaking.length;

  // «Топ дня» (top of the day) — current day in UTC+7 only; marks from past days are reset (there was a bug with «42 топа» (42 tops))
  const nowDay = ownerDay(now.toISOString(), tz);
  const dayEvents = nowDay ? all.filter((e) => ownerDay(e.first_seen, tz) === nowDay) : [];
  const top = topOfDay(dayEvents, {
    min: cfg.owner_feed_min ?? 40, perDay: cfg.owner_feed_top_per_day ?? 7, tzHours: tz,
    perGroup, minOutside, politics, relax: div.relax_points ?? 0, ceilings: div.ceilings,
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
    console.error('Usage: npm run select -- [--hours N]');
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
      kinds: kindsOf(sources),
    });
    console.log(`items ${r.items}, events ${r.events}, selected ${r.selected}, rejected ${r.rejected}, top of day ${r.top}, urgent ${r.breaking}, hype spikes ${r.hype}`);
  } finally {
    store.close();
  }
}
