import { getJson, pause } from './http.js';

const API = 'https://wikimedia.org/api/rest_v1/metrics/pageviews/top';
const SERVICE = /^(Main_Page|Заглавная_страница|-|Special:|Служебная:|Wikipedia:|Википедия:|Portal:|Портал:|File:|Файл:|Help:|Справка:|Category:|Категория:|Talk:|Обсуждение|Template:|Шаблон:|User:|Участник:)/i;

/** top-API response → [{ article, views }] without service pages. An empty or broken response → []. */
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
 * "Sharp rise": the day's views against the median of the previous days. An article that is not in the top 1000
 * of that day counts as that day's threshold (it could not have scored lower — the estimate is conservative).
 * latest: [{article, views}], history: [[{article, views}], …] (per day). Returns [{article, views, median, ratio}].
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

/** Sharply risen articles → radar records. day — the data date (YYYY-MM-DD), now — the collection time. */
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
 * Top views for the last available day (yesterday; if not yet out — the day before) and baseline_days days before it.
 * Wikimedia has no today's top until the day ends.
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
    if (e.status === 429) return []; // rate limit — skip without a radar error
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
      if (e.status === 429) break; // count with whatever was collected
      if (e.status !== 404) throw e;
    }
  }
  if (!history.length) return [];
  return toItems(surges(latest.rows, history, { minViews: source.min_views, ratio: source.ratio }), source, latest.day, now);
}
