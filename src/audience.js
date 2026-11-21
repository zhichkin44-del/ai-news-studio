import { readFileSync } from 'node:fs';

export const DEFAULT_AUDIENCE = JSON.parse(readFileSync(new URL('./audience.json', import.meta.url), 'utf8'));

const norm = (s) => ` ${String(s ?? '').toLowerCase().replace(/ё/g, 'е')} `;
const cache = new Map();
// A trigger matches from the start of a word; the word ending is covered by the trigger itself.
// In JS, \w matches only Latin letters, so in triggers it reads as "any letter/digit" (Russian word endings).
const rx = (p) => {
  if (!cache.has(p)) cache.set(p, new RegExp(`(?<![\\p{L}\\p{N}])(?:${p.replace(/\\w/g, '[\\p{L}\\p{N}_]')})`, 'u'));
  return cache.get(p);
};
const hit = (text, list = []) => list.some((p) => rx(p).test(text));

/**
 * "Shock" — how strongly the news hits: a class from profile.shock (weight + trigger rarity),
 * scale (numbers/casualties) and confirmation by independent sources. Without confirmation
 * (2+ sources or a lead feed) no shock is awarded: a rumor must not flood the feed.
 * Pure function. Returns { points, reasons[], classes[], group, confirmed }.
 */
export function shockScore(event, profile = DEFAULT_AUDIENCE) {
  const shock = profile.shock;
  if (!shock?.classes?.length) return { points: 0, reasons: [], classes: [], group: null, confirmed: false };
  const text = norm(event.title);
  const hits = shock.classes.filter((c) => hit(text, c.triggers)).sort((a, b) => b.weight - a.weight);
  if (!hits.length) return { points: 0, reasons: [], classes: [], group: null, confirmed: false };
  const [top] = hits;
  const confirmed = (event.independentSources ?? 0) >= 2 || !!event.authority;
  if (!confirmed) {
    return { points: 0, reasons: [`шок: «${top.name}» без подтверждения → 0`], classes: hits.map((c) => c.name), group: top.group, confirmed: false };
  }
  const reasons = [`шок: «${top.name}» → ${top.weight}`];
  let points = top.weight;
  const rarity = Math.max(...hits.map((c) => c.rarity ?? 0.5));
  const rare = Math.round((shock.rare_bonus ?? 0) * rarity);
  if (rare) { points += rare; reasons.push(`шок: редкость слова-триггера ${rarity} → ${rare}`); }
  if (hit(text, shock.scale_triggers ?? [])) {
    points += shock.scale_bonus ?? 0;
    reasons.push(`шок: масштаб → ${shock.scale_bonus ?? 0}`);
  }
  points += shock.confirmed_bonus ?? 0;
  reasons.push(`шок: подтверждено источниками → ${shock.confirmed_bonus ?? 0}`);
  points = Math.min(points, shock.max_points ?? 40);
  return { points, reasons, classes: hits.map((c) => c.name), group: top.group, confirmed: true };
}

/**
 * Audience relevance by profile. Pure function.
 * event: { title, summary?, ru? } — ru: a Russian-language source exists (otherwise detected by Cyrillic in the title).
 * Returns { points, topic, category, reasons[] }.
 */
export function audienceScore(event, profile = DEFAULT_AUDIENCE) {
  const text = norm(event.title); // title only: words like "Ukraine" or "army" show up in descriptions in any context
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
    // a weak topic (below the ru_bonus threshold) does not get the category weight
    const cw = hits[0].weight >= (profile.ru_bonus_min_weight ?? 0) ? profile.category_weights?.[category] ?? 0 : 0;
    if (cw) { points += cw; reasons.push(`аудитория: категория «${category}» → ${cw}`); }
    const ru = event.ru ?? /[а-яё]/i.test(event.title ?? '');
    if (ru && profile.ru_bonus && hits[0].weight >= (profile.ru_bonus_min_weight ?? 0)) { points += profile.ru_bonus; reasons.push(`аудитория: русскоязычный источник → ${profile.ru_bonus}`); }
  }
  let cancelShock = false;
  for (const p of profile.penalties ?? []) {
    const on = (p.any ? hit(text, p.any) : true) && (p.all ? p.all.every((g) => hit(text, g)) : true) && !hit(text, p.unless);
    if ((p.any || p.all) && on) { points -= p.points; reasons.push(`аудитория: ${p.name} → -${p.points}`); if (p.cancel_shock) cancelShock = true; }
  }
  return { points, topic, category, reasons, cancelShock };
}
