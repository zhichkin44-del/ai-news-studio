import { getJson, pause } from './http.js';

const API = 'https://wikimedia.org/api/rest_v1/metrics/pageviews/top';
const SERVICE = /^(Main_Page|Заглавная_страница|-|Special:|Служебная:|Wikipedia:|Википедия:|Portal:|Портал:|File:|Файл:|Help:|Справка:|Category:|Категория:|Talk:|Обсуждение|Template:|Шаблон:|User:|Участник:)/i;

/** Ответ top-API → [{ article, views }] без служебных страниц. Пустой/битый ответ — []. */
export function parseTop(json) {
  return (json?.items?.[0]?.articles ?? [])
    .filter((a) => a?.article && Number.isFinite(a.views) && !SERVICE.test(a.article))
    .map((a) => ({ article: a.article, views: a.views }));
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

/**
 * «Резкий рост»: просмотры дня против медианы предыдущих дней. Статья, не попавшая в топ-1000
 * того дня, считается за порог этого дня (меньше она набрать не могла — оценка консервативна).
 * latest: [{article, views}], history: [[{article, views}], …] (по дням). Возвращает [{article, views, median, ratio}].
 */
export function surges(latest, history, { minViews = 20000, ratio = 3 } = {}) {
  const cutoffs = history.map((day) => Math.min(...day.map((a) => a.views), Infinity)).map((c) => (Number.isFinite(c) ? c : 0));
  const maps = history.map((day) => new Map(day.map((a) => [a.article, a.views])));
  const out = [];
  for (const { article, views } of latest) {
    if (views < minViews) continue;
    const med = median(maps.map((m, i) => m.get(article) ?? cutoffs[i]));
    const r = views / Math.max(med, 1);
    if (r >= ratio) out.push({ article, views, median: Math.round(med), ratio: Math.round(r * 10) / 10 });
  }
  return out.sort((a, b) => b.ratio - a.ratio || b.views - a.views);
}

/** Резко выросшие статьи → записи радара. day — дата данных (ГГГГ-ММ-ДД), now — время сбора. */
export function toItems(rows, source, day, now = new Date()) {
  const host = source.project.replace('.wikipedia', '.wikipedia.org');
  return rows.map((r) => ({
    id: `${source.id}:${r.article}:${day}`,
    source: source.id,
    title: r.article.replace(/_/g, ' '),
    summary: `Википедия ${source.project.split('.')[0]}: ${r.views} просмотров за ${day}, в ${r.ratio} раза выше обычного`,
    link: `https://${host}/wiki/${encodeURIComponent(r.article).replace(/%3A/gi, ':')}`,
    published: now.toISOString(),
    image: null,
    meta: { type: 'wikipedia', project: source.project, views: r.views, median: r.median, ratio: r.ratio, day },
  }));
}

const ymd = (d) => [d.getUTCFullYear(), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0')];

/**
 * Топ просмотров за последний доступный день (вчера; если не вышел — позавчера) и baseline_days дней до него.
 * Сегодняшнего топа у Викимедии нет до конца суток.
 */
export async function fetchWikipedia(source, { fetchImpl = fetch, sleep = pause, now = new Date(), ...opts } = {}) {
  const baseDays = source.baseline_days ?? 6;
  const get = async (offset) => {
    const d = new Date(now.getTime() - offset * 864e5);
    const [y, m, dd] = ymd(d);
    return { day: `${y}-${m}-${dd}`, rows: parseTop(await getJson(`${API}/${source.project}/all-access/${y}/${m}/${dd}`, { fetchImpl, ...opts })) };
  };
  let latest;
  try {
    latest = await get(1);
  } catch (e) {
    if (e.status === 429) return []; // лимит — пропуск без ошибки радара
    if (e.status !== 404) throw e;
    latest = await get(2);
  }
  const shift = Math.round((now.getTime() - Date.parse(latest.day)) / 864e5);
  const history = [];
  for (let i = 1; i <= baseDays; i++) {
    await sleep(source.pause_ms ?? 300);
    try {
      history.push((await get(shift + i)).rows);
    } catch (e) {
      if (e.status === 429) break; // считаем по тому, что успели
      if (e.status !== 404) throw e;
    }
  }
  if (!history.length) return [];
  return toItems(surges(latest.rows, history, { minViews: source.min_views, ratio: source.ratio }), source, latest.day, now);
}
