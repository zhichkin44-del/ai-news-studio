const STOP = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'to', 'for', 'and', 'at', 'as', 'is', 'by', 'with', 'after', 'over', 'from', 'says', 'say',
  'и', 'в', 'во', 'на', 'с', 'со', 'по', 'за', 'к', 'о', 'об', 'от', 'до', 'из', 'для', 'не', 'что', 'как', 'при', 'у', 'а', 'но']);

/** Токены заголовка: нижний регистр, без стоп-слов, грубая основа (первые 5 букв). */
export function tokens(title) {
  const words = title.toLowerCase().replace(/ё/g, 'е').match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(words.filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.slice(0, 5)));
}

/** Сходство Жаккара между наборами токенов. */
export function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const t of a) if (b.has(t)) common++;
  return common / (a.size + b.size - common);
}

/** Склеивает близкие заголовки в кластеры (одиночная связь). */
export function cluster(items, threshold = 0.4, groups = {}) {
  const sets = items.map((i) => tokens(i.title));
  const parent = items.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++)
      if (items[i].link === items[j].link || similarity(sets[i], sets[j]) >= threshold) parent[find(j)] = find(i);
  const byRoot = new Map();
  items.forEach((it, i) => {
    const r = find(i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(it);
  });
  return [...byRoot.values()].map((g) => buildCluster(g, groups));
}

function buildCluster(items, groups) {
  const sorted = [...items].sort((a, b) => (b.published ?? '').localeCompare(a.published ?? ''));
  // одна запись на издателя (groups сводит ленты одного издателя, напр. BBC): повторы не независимы
  const bySource = new Map();
  for (const it of sorted) { const k = groups[it.source] ?? it.source; if (!bySource.has(k)) bySource.set(k, it); }
  const sources = [...bySource.values()];
  return {
    title: sources[0].title,
    items: sorted,
    sources,
    sourceCount: sources.length,
    newest: sorted[0].published,
    status: verify(sources.length),
  };
}

/** Проверка по паспорту (разд. 9): ≥2 независимых источников — подтверждено. */
export function verify(sourceCount) {
  return sourceCount >= 2 ? 'подтверждено' : 'не подтверждено';
}

/** Оценка: число источников × свежесть (полураспад 12 ч). */
export function score(c, now = Date.now()) {
  const ageH = c.newest ? Math.max(0, (now - Date.parse(c.newest)) / 3.6e6) : 48;
  return c.sourceCount * Math.pow(0.5, ageH / 12);
}

export function select(items, { n = 10, now = Date.now(), threshold, groups } = {}) {
  return cluster(items, threshold, groups)
    .map((c) => ({ ...c, score: score(c, now) }))
    .sort((a, b) => b.score - a.score || (b.newest ?? '').localeCompare(a.newest ?? ''))
    .slice(0, n);
}
