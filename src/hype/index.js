import { fetchFeed } from '../collect.js';
import { fetchTrends } from './google-trends.js';
import { fetchReddit } from './reddit.js';
import { fetchWikipedia } from './wikipedia.js';
import { fetchBluesky } from './bluesky.js';

export const LOADERS = { trends: fetchTrends, reddit: fetchReddit, wikipedia: fetchWikipedia, bluesky: fetchBluesky };

export const isHype = (source) => source?.type === 'hype';

/** Records of a hype source: sources.json → { type: 'hype', kind: trends|reddit|wikipedia|bluesky }. */
export function fetchHype(source, opts) {
  const load = LOADERS[source.kind];
  if (!load) throw new Error(`неизвестный вид источника хайпа: ${source.kind}`);
  return load(source, opts);
}

/** Radar loader: media feeds — as before; hype signals — their own modules. */
export const fetchSource = (source, opts) => (isHype(source) ? fetchHype(source, opts) : fetchFeed(source, opts));

/** Source id → signal kind (trends/reddit/wikipedia/bluesky); media feeds have no kind. */
export const kindsOf = (sources) => Object.fromEntries(sources.filter(isHype).map((s) => [s.id, s.kind]));
