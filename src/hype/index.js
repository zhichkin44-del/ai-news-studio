import { fetchFeed } from '../collect.js';
import { fetchTrends } from './google-trends.js';
import { fetchReddit } from './reddit.js';
import { fetchWikipedia } from './wikipedia.js';
import { fetchBluesky } from './bluesky.js';

export const LOADERS = { trends: fetchTrends, reddit: fetchReddit, wikipedia: fetchWikipedia, bluesky: fetchBluesky };

export const isHype = (source) => source?.type === 'hype';

/** Записи источника хайпа: sources.json → { type: 'hype', kind: trends|reddit|wikipedia|bluesky }. */
export function fetchHype(source, opts) {
  const load = LOADERS[source.kind];
  if (!load) throw new Error(`неизвестный вид источника хайпа: ${source.kind}`);
  return load(source, opts);
}

/** Загрузчик радара: ленты СМИ — как раньше, хайп-сигналы — свои модули. */
export const fetchSource = (source, opts) => (isHype(source) ? fetchHype(source, opts) : fetchFeed(source, opts));

/** id источника → вид сигнала (trends/reddit/wikipedia/bluesky); у лент СМИ вида нет. */
export const kindsOf = (sources) => Object.fromEntries(sources.filter(isHype).map((s) => [s.id, s.kind]));
