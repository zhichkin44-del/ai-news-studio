import { keys } from './cluster.js';

/**
 * Feed diversity groups (owner's decision of 28.10): politics/war — no more than
 * two events in a seven; the other groups make up the mix. An event's group is taken
 * from its shock class (more precise there), otherwise from the feed category.
 */
export const POLITICS = 'политика/война';
export const WORLD_EMERGENCY = 'мир и ЧП';
export const SCIENCE = 'наука';
export const TECH = 'технологии и ИИ';
export const ECONOMY = 'экономика';
export const CULTURE = 'культура/спорт/знаменитости';

export const CATEGORY_SECTION = {
  war: POLITICS, russia: POLITICS, politics: POLITICS, world: POLITICS,
  accidents: WORLD_EMERGENCY, society: WORLD_EMERGENCY,
  science: SCIENCE, space: SCIENCE, health: SCIENCE,
  tech: TECH,
  economy: ECONOMY,
  celebrity: CULTURE, sport: CULTURE, culture: CULTURE,
};

export const sectionOf = (event) => event.section ?? CATEGORY_SECTION[event.category] ?? WORLD_EMERGENCY;

/**
 * Event group at selection time. The general shock class «мир и ЧП» (world and emergencies: dead, casualties) must not
 * hide war/politics from the quota: if the audience topic is war/russia, the group is politics/war.
 * Special shock groups (science, AI, economy, celebrities) are kept.
 */
export function sectionFor({ shockGroup, audienceCategory, feedCategory } = {}) {
  const topic = CATEGORY_SECTION[audienceCategory];
  if (topic === POLITICS && audienceCategory !== 'world' && (!shockGroup || shockGroup === WORLD_EMERGENCY)) return POLITICS;
  return shockGroup ?? topic ?? CATEGORY_SECTION[feedCategory] ?? WORLD_EMERGENCY;
}

/** Event score for the top and the digest: peak, otherwise current. */
export const peakOf = (event) => Number(event.peak_score ?? event.score ?? 0);

const tie = (a, b) => String(a.first_seen ?? '').localeCompare(String(b.first_seen ?? '')) || String(a.id ?? '').localeCompare(String(b.id ?? ''));
const ranked = (events, scoreOf) => [...events].sort((a, b) => scoreOf(b) - scoreOf(a) || tie(a, b));

/** Ceiling keys, separate from the section: sport and showbiz share one section but are capped separately. */
export const SPORT = 'спорт';
export const SHOWBIZ = 'шоу-бизнес';
const ceilingKey = (e) => (e.category === 'sport' ? SPORT : e.category === 'celebrity' ? SHOWBIZ : sectionOf(e));

/**
 * Per-group ceilings in the day's top (score.config.json → diversity.ceilings), strict mode:
 * { sport, showbiz, topic, politics, sport_sensation: [regex markers] }. Sport without a sensation marker
 * (record, scandal, final, mega-sum) does not make it into the top at all.
 */
export function ceilingRules(ceilings, politics = POLITICS) {
  if (!ceilings) return null;
  const sens = (ceilings.sport_sensation ?? []).map((m) => new RegExp(m, 'iu'));
  const caps = { [SPORT]: ceilings.sport ?? 1, [SHOWBIZ]: ceilings.showbiz ?? 1, [politics]: ceilings.politics ?? 3 };
  const topic = ceilings.topic ?? 2;
  return {
    capOf: (key) => caps[key] ?? topic,
    allowed: (e) => e.category !== 'sport' || sens.some((re) => re.test(`${e.title ?? ''} ${e.summary ?? ''}`)),
  };
}

/**
 * The same story in different wording: a shared number (not a year) and at least one shared
 * entity (word stem of ≥ 4 characters), or nearly identical word sets (Jaccard ≥ 0.6).
 */
export function sameStory(a, b) {
  const ka = keys(a.title ?? '');
  const kb = keys(b.title ?? '');
  const nums = (k) => [...k.keys()].filter((t) => /^\d+$/.test(t) && !/^(19|20)\d\d$/.test(t));
  const words = (k) => [...k.keys()].filter((t) => !/^\d+$/.test(t) && t.length >= 4);
  const wa = words(ka);
  const common = wa.filter((t) => kb.has(t)).length;
  const sharedNum = nums(ka).some((t) => kb.has(t));
  if (sharedNum && common >= 1) return true;
  const wb = words(kb);
  return common >= 3 && common / (wa.length + wb.length - common || 1) >= 0.6;
}

/**
 * A mix of `limit` events: no more than `perGroup` from one group; if there is an event outside
 * politics with score ≥ minScore — at least `minOutside` outside politics (politics is displaced if needed).
 * Returns the chosen events in descending score order.
 * With `ceilings` (strict) the per-group ceilings replace perGroup; free slots stay empty.
 */
export function pickDiverse(events, {
  limit = 7, perGroup = 2, minOutside = 3, minScore = 40, politics = POLITICS, scoreOf = peakOf, strict = false, ceilings = null, politicsShare = 1 / 3,
} = {}) {
  const rules = strict ? ceilingRules(ceilings, politics) : null;
  const list = ranked(events, scoreOf).filter((e) => !rules || rules.allowed(e));
  const keyOf = rules ? ceilingKey : sectionOf;
  const capOf = rules ? rules.capOf : () => perGroup;
  const chosen = [];
  const counts = new Map();
  // hard quota: politics no more than limit - minOutside; empty slots are not filled with war
  // and not more than a third (politics/war treated the same in the top and in the digests)
  const politicsCap = strict ? Math.max(0, Math.min(limit - Math.min(minOutside, limit), Math.floor(limit * politicsShare))) : Infinity;
  const take = (e) => {
    chosen.push(e);
    const s = keyOf(e);
    counts.set(s, (counts.get(s) ?? 0) + 1);
  };
  const drop = (e) => {
    const i = chosen.indexOf(e);
    if (i < 0) return;
    chosen.splice(i, 1);
    const s = keyOf(e);
    counts.set(s, counts.get(s) - 1);
  };
  for (const e of list) {
    if (chosen.length >= limit) break;
    const s = keyOf(e);
    if ((counts.get(s) ?? 0) >= capOf(s)) continue;
    if (s === politics && (counts.get(s) ?? 0) >= politicsCap) continue;
    if (chosen.some((c) => sameStory(c, e))) continue;
    take(e);
  }
  const outside = () => chosen.filter((e) => sectionOf(e) !== politics).length;
  const target = Math.min(minOutside, limit);
  const hasOutside = list.some((e) => sectionOf(e) !== politics && scoreOf(e) >= minScore);
  if (hasOutside) {
    while (outside() < target) {
      const candidate = list.find((e) => !chosen.includes(e) && !chosen.some((c) => sameStory(c, e)) && sectionOf(e) !== politics && scoreOf(e) >= minScore && (counts.get(keyOf(e)) ?? 0) < capOf(keyOf(e)));
      if (!candidate) break;
      if (chosen.length >= limit) {
        const victim = [...chosen].reverse().find((e) => sectionOf(e) === politics);
        if (!victim) break;
        drop(victim);
      }
      take(candidate);
    }
  }
  return ranked(chosen, scoreOf);
}
