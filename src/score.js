import { readFileSync } from 'node:fs';
import { audienceScore, shockScore, DEFAULT_AUDIENCE } from './audience.js';

export const DEFAULT_CONFIG = JSON.parse(readFileSync(new URL('./score.config.json', import.meta.url), 'utf8'));

const norm = (s) => ` ${String(s ?? '').toLowerCase().replace(/ё/g, 'е')} `;
const matches = (text, list) => list.some((p) => new RegExp(p, 'u').test(text));
const ms = (iso) => (iso ? Date.parse(iso) : NaN);

/**
 * Event heat on the 01-selection.md scale. Pure function.
 * event: { title, summary?, firstSeen, independentSources, times?: [ISO] — time of all cluster messages,
 *   category?: world|science|tech|space|health|economy, authority?: true — a leading source of the category exists }.
 * Returns { score, reasons[], needsOwner, single, acute, topic }.
 */
export function score(event, { now = Date.now(), config = DEFAULT_CONFIG, audience = DEFAULT_AUDIENCE } = {}) {
  const reasons = [];
  const first = ms(event.firstSeen);
  const ageMin = Number.isNaN(first) ? Infinity : Math.max(0, (now - first) / 60000);
  const fr = config.freshness.find((t) => ageMin <= t.maxMinutes)?.points ?? 0;
  reasons.push(`свежесть: ${Number.isFinite(ageMin) ? Math.round(ageMin) + ' мин' : 'время неизвестно'} → ${fr}`);

  const n = Math.max(0, Math.floor(event.independentSources ?? 0));
  const srcPts = n === 0 ? 0 : config.sources[Math.min(n, 3)] ?? 0;
  reasons.push(`независимых источников: ${n} → ${srcPts}`);

  const text = norm(`${event.title} ${event.summary ?? ''}`);
  const topic = Object.keys(config.topics).find((k) => matches(text, config.topics[k])) ?? null;
  const threat = matches(text, config.threat);
  let topicPts = 0;
  if (topic) topicPts = threat ? config.topic.listed_threat : config.topic.listed;
  else if (matches(text, config.notable)) topicPts = config.topic.notable;
  reasons.push(topic ? `тема «${topic}»${threat ? ' с жертвами/угрозой' : ''} → ${topicPts}` : `тема вне списка → ${topicPts}`);

  const w = config.growth.windowMinutes * 60000;
  const growthN = (event.times ?? []).map(ms).filter((t) => !Number.isNaN(t) && t > first && t - first <= w).length;
  const growthPts = config.growth.tiers.find((t) => growthN >= t.min)?.points ?? 0;
  reasons.push(`сообщений за ${config.growth.windowMinutes} мин после первого: ${growthN} → ${growthPts}`);

  // science/technology/space/medicine/economy: category weight, "wow" markers, category leader, stop-words
  let extra = 0;
  const cat = event.category ?? null;
  if (cat && cat !== 'world' && config.wow && cat in (config.category_weights ?? {})) {
    const wc = config.wow;
    const catPts = config.category_weights?.[cat] ?? 0;
    const head = norm(event.title); // markers — by headline only: "discover the…" appears almost everywhere in descriptions
    const stop = matches(head, wc.stop);
    const wow = !stop && matches(head, wc.markers);
    const authority = !!event.authority;
    const confirmed = n >= 2 || authority;
    extra += catPts;
    reasons.push(`категория «${cat}» → ${catPts}`);
    if (stop) {
      extra -= wc.stop_penalty;
      reasons.push(`реклама/обзор/скидка → -${wc.stop_penalty}`);
    } else if (wow) {
      const wowPts = confirmed ? wc.points : wc.unconfirmed_points;
      extra += wowPts;
      reasons.push(`маркер прорыва${confirmed ? '' : ' (не подтверждён)'} → ${wowPts}`);
      if (authority && n < 2) {
        extra += wc.authority_points;
        reasons.push(`ведущий источник категории → ${wc.authority_points}`);
      }
    }
  }

  // relevance to the mass Russian-speaking audience (profile src/audience.json)
  const aud = audience ? audienceScore(event, audience) : { points: 0, reasons: [], category: null };
  reasons.push(...aud.reasons);

  // "shock": scale, rarity of the trigger word and the number of independent sources
  let shock = audience ? shockScore({ ...event, independentSources: n }, audience) : { points: 0, reasons: [], group: null };
  // a routine digest («погиб пресс-офицер» (press officer died), a briefing) gets no shock points for the single word «погиб» (died)
  if (aud.cancelShock && shock.points) shock = { ...shock, points: 0, reasons: ['шок отменён: однотипная сводка → 0'] };
  reasons.push(...shock.reasons);

  // "Signals" (category + audience + shock) are counted once: otherwise the same headline
  // would raise the score three times (wow «discover» + audience + shock) and the top would hit 100.
  const signals = extra + aud.points + shock.points;
  const signalMax = config.signals_max ?? 50;
  const capped = Math.min(signalMax, signals);
  if (signals > signalMax) reasons.push(`сигналы ${signals} ограничены ${signalMax}`);

  // "hype": the topic gained momentum on social media/search and is confirmed by different kinds of sources (weight — audience.json → hype)
  let hypePts = 0;
  const hv = audience?.hype;
  if (event.hype && hv) {
    const types = Math.max(2, event.hype.types ?? 2);
    hypePts = Math.min(hv.max_points, hv.base + hv.per_type * (types - 2) + ((event.hype.ratio ?? 0) >= hv.big_ratio ? hv.big_bonus : 0));
    reasons.push(`хайп: всплеск ×${event.hype.ratio ?? '?'}, видов источников ${types} → ${hypePts}`);
  }

  const acute = matches(text, config.acute);
  const single = n < 2;
  if (single) reasons.push('одно-источниковое: только с одобрения владельца');
  if (acute) reasons.push('острое: только с одобрения владельца');
  return {
    score: Math.min(100, Math.max(0, fr + srcPts + topicPts + growthPts + capped + hypePts)),
    reasons, needsOwner: single || acute, single, acute, topic, audience: aud.points, audienceCategory: aud.category, hype: hypePts,
    shock: shock.points, shockGroup: shock.group,
  };
}

/**
 * Urgent: score ≥ threshold and confirmed by 2+ sources (publishers) that published within the last 60 minutes.
 * sources: [{ published }] — one record per publisher (as in the cluster).
 */
export function isBreaking(scoreValue, sources, { now = Date.now(), config = DEFAULT_CONFIG } = {}) {
  const b = config.breaking ?? DEFAULT_CONFIG.breaking;
  const from = now - b.window_minutes * 60000;
  const recent = sources.map((s) => ms(s.published)).filter((t) => t >= from && t <= now + 60000).length;
  return scoreValue >= b.min_score && recent >= b.min_sources;
}

/** 'urgent' (≥70) | 'plan' (40–69) | 'below'. */
export function band(value, config = DEFAULT_CONFIG) {
  return value >= config.thresholds.urgent ? 'urgent' : value >= config.thresholds.publish ? 'plan' : 'below';
}
