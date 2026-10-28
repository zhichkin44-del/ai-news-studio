import { cluster } from './cluster.js';

export { cluster };

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
