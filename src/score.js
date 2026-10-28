import { readFileSync } from 'node:fs';

export const DEFAULT_CONFIG = JSON.parse(readFileSync(new URL('./score.config.json', import.meta.url), 'utf8'));

const norm = (s) => ` ${String(s ?? '').toLowerCase().replace(/ё/g, 'е')} `;
const matches = (text, list) => list.some((p) => new RegExp(p, 'u').test(text));
const ms = (iso) => (iso ? Date.parse(iso) : NaN);

/**
 * Горячесть события по шкале 01-selection.md. Чистая функция.
 * event: { title, summary?, firstSeen, independentSources, times?: [ISO] — время всех сообщений кластера }.
 * Возвращает { score, reasons[], needsOwner, single, acute, topic }.
 */
export function score(event, { now = Date.now(), config = DEFAULT_CONFIG } = {}) {
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

  const acute = matches(text, config.acute);
  const single = n < 2;
  if (single) reasons.push('одно-источниковое: только с одобрения владельца');
  if (acute) reasons.push('острое: только с одобрения владельца');
  return { score: fr + srcPts + topicPts + growthPts, reasons, needsOwner: single || acute, single, acute, topic };
}

/** 'urgent' (≥70) | 'plan' (40–69) | 'below'. */
export function band(value, config = DEFAULT_CONFIG) {
  return value >= config.thresholds.urgent ? 'urgent' : value >= config.thresholds.publish ? 'plan' : 'below';
}
