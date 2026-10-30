import { keys } from './cluster.js';

/**
 * Группы разнообразия ленты (решение владельца 28.10): политика/война — не больше
 * двух событий в семёрке, остальные группы закрывают микс. Группа события берётся
 * из шокового класса (там она точнее), иначе — из категории ленты.
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
 * Группа события при отборе. Общий шоковый класс «мир и ЧП» (погибшие, жертвы) не должен
 * прятать войну/политику от квоты: если тема аудитории — war/russia, группа — политика/война.
 * Специальные группы шока (наука, ИИ, экономика, знаменитости) сохраняются.
 */
export function sectionFor({ shockGroup, audienceCategory, feedCategory } = {}) {
  const topic = CATEGORY_SECTION[audienceCategory];
  if (topic === POLITICS && audienceCategory !== 'world' && (!shockGroup || shockGroup === WORLD_EMERGENCY)) return POLITICS;
  return shockGroup ?? topic ?? CATEGORY_SECTION[feedCategory] ?? WORLD_EMERGENCY;
}

/** Оценка события для топа и дайджеста: пиковая, иначе текущая. */
export const peakOf = (event) => Number(event.peak_score ?? event.score ?? 0);

const tie = (a, b) => String(a.first_seen ?? '').localeCompare(String(b.first_seen ?? '')) || String(a.id ?? '').localeCompare(String(b.id ?? ''));
const ranked = (events, scoreOf) => [...events].sort((a, b) => scoreOf(b) - scoreOf(a) || tie(a, b));

/** Ключи потолков, отдельные от секции: спорт и шоу-бизнес живут в одной секции, но режутся порознь. */
export const SPORT = 'спорт';
export const SHOWBIZ = 'шоу-бизнес';
const ceilingKey = (e) => (e.category === 'sport' ? SPORT : e.category === 'celebrity' ? SHOWBIZ : sectionOf(e));

/**
 * Потолки на группу в топе дня (score.config.json → diversity.ceilings), strict-режим:
 * { sport, showbiz, topic, politics, sport_sensation: [regex-маркеры] }. Спорт без маркера
 * сенсации (рекорд, скандал, финал, сверхсумма) в топ не идёт вовсе.
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
 * Один и тот же сюжет в разных формулировках: общее число (не год) и хотя бы одна общая
 * сущность (основа слова ≥ 4 знаков), либо почти совпадающие наборы слов (Жаккар ≥ 0,6).
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
 * Микс из `limit` событий: не больше `perGroup` одной группы; если есть событие вне
 * политики с оценкой ≥ minScore — минимум `minOutside` вне политики (политику при
 * необходимости вытесняем). Возвращает выбранные события в порядке убывания оценки.
 * С `ceilings` (strict) потолки по группам заменяют perGroup; свободные места остаются пустыми.
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
  // жёсткая квота: политики не больше limit - minOutside, пустые места не добиваем войной
  // и не больше трети (политика/война одинаково в топе и дайджестах)
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
