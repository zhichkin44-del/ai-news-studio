import { readFileSync } from 'node:fs';

export const DEFAULT_AUDIENCE = JSON.parse(readFileSync(new URL('./audience.json', import.meta.url), 'utf8'));

const norm = (s) => ` ${String(s ?? '').toLowerCase().replace(/ё/g, 'е')} `;
const cache = new Map();
// триггер — с начала слова; конец слова закрывается в самом триггере
const rx = (p) => {
  if (!cache.has(p)) cache.set(p, new RegExp(`(?<![\\p{L}\\p{N}])(?:${p})`, 'u'));
  return cache.get(p);
};
const hit = (text, list = []) => list.some((p) => rx(p).test(text));

/**
 * Релевантность аудитории по профилю. Чистая функция.
 * event: { title, summary?, ru? } — ru: есть русскоязычный источник (иначе по кириллице в заголовке).
 * Возвращает { points, topic, category, reasons[] }.
 */
export function audienceScore(event, profile = DEFAULT_AUDIENCE) {
  const text = norm(event.title); // только заголовок: в описаниях «Украина», «армия» и т. п. попадаются в чём угодно
  const reasons = [];
  const hits = profile.topics.filter((t) => hit(text, t.triggers)).sort((a, b) => b.weight - a.weight);
  let points = 0;
  let topic = null;
  let category = null;
  if (hits.length) {
    [{ name: topic, category }] = hits;
    const extra = Math.min((hits.length - 1) * profile.extra_topic, profile.extra_cap);
    points = hits[0].weight + extra;
    reasons.push(`аудитория: «${topic}» → ${hits[0].weight}${extra ? ` (+${extra} за ещё ${hits.length - 1} тем)` : ''}`);
    const cw = profile.category_weights?.[category] ?? 0;
    if (cw) { points += cw; reasons.push(`аудитория: категория «${category}» → ${cw}`); }
    const ru = event.ru ?? /[а-яё]/i.test(event.title ?? '');
    if (ru && profile.ru_bonus && hits[0].weight >= (profile.ru_bonus_min_weight ?? 0)) { points += profile.ru_bonus; reasons.push(`аудитория: русскоязычный источник → ${profile.ru_bonus}`); }
  }
  for (const p of profile.penalties ?? []) {
    const on = (p.any ? hit(text, p.any) : true) && (p.all ? p.all.every((g) => hit(text, g)) : true) && !hit(text, p.unless);
    if ((p.any || p.all) && on) { points -= p.points; reasons.push(`аудитория: ${p.name} → -${p.points}`); }
  }
  return { points, topic, category, reasons };
}
