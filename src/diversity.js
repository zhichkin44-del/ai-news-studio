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

/** Оценка события для топа и дайджеста: пиковая, иначе текущая. */
export const peakOf = (event) => Number(event.peak_score ?? event.score ?? 0);

const tie = (a, b) => String(a.first_seen ?? '').localeCompare(String(b.first_seen ?? '')) || String(a.id ?? '').localeCompare(String(b.id ?? ''));
const ranked = (events, scoreOf) => [...events].sort((a, b) => scoreOf(b) - scoreOf(a) || tie(a, b));

/**
 * Микс из `limit` событий: не больше `perGroup` одной группы; если есть событие вне
 * политики с оценкой ≥ minScore — минимум `minOutside` вне политики (политику при
 * необходимости вытесняем). Возвращает выбранные события в порядке убывания оценки.
 */
export function pickDiverse(events, {
  limit = 7, perGroup = 2, minOutside = 3, minScore = 40, politics = POLITICS, scoreOf = peakOf,
} = {}) {
  const list = ranked(events, scoreOf);
  const chosen = [];
  const counts = new Map();
  const take = (e) => {
    chosen.push(e);
    const s = sectionOf(e);
    counts.set(s, (counts.get(s) ?? 0) + 1);
  };
  const drop = (e) => {
    const i = chosen.indexOf(e);
    if (i < 0) return;
    chosen.splice(i, 1);
    const s = sectionOf(e);
    counts.set(s, counts.get(s) - 1);
  };
  for (const e of list) {
    if (chosen.length >= limit) break;
    const s = sectionOf(e);
    if ((counts.get(s) ?? 0) >= perGroup) continue;
    take(e);
  }
  const outside = () => chosen.filter((e) => sectionOf(e) !== politics).length;
  const target = Math.min(minOutside, limit);
  const hasOutside = list.some((e) => sectionOf(e) !== politics && scoreOf(e) >= minScore);
  if (hasOutside) {
    while (outside() < target) {
      const candidate = list.find((e) => !chosen.includes(e) && sectionOf(e) !== politics && scoreOf(e) >= minScore && (counts.get(sectionOf(e)) ?? 0) < perGroup);
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
