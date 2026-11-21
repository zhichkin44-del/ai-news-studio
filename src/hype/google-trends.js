import { decode } from '../collect.js';
import { getText, iso, parseTraffic } from './http.js';

const ENDPOINT = 'https://trends.google.com/trending/rss';
const inner = (block, name) => {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim() : '';
};

/**
 * Google Trends «в тренде сейчас» ("trending now", RSS): query, traffic (ht:approx_traffic) and related news.
 * source: { id, geo }. Record: title — the query, summary — headlines of related news, meta.traffic — the number of searches.
 */
export function parseTrends(xml, source) {
  const out = [];
  for (const block of xml.match(/<item>[\s\S]*?<\/item>/gi) ?? []) {
    const query = inner(block, 'title');
    if (!query) continue;
    const news = [...block.matchAll(/<ht:news_item>([\s\S]*?)<\/ht:news_item>/gi)].map((m) => ({
      title: inner(m[1], 'ht:news_item_title'), url: inner(m[1], 'ht:news_item_url'), source: inner(m[1], 'ht:news_item_source'),
    })).filter((n) => n.title);
    const published = iso(inner(block, 'pubDate'));
    const day = (published ?? '').slice(0, 10);
    const geo = source.geo ?? '';
    out.push({
      id: `${source.id}:${query.toLowerCase()}:${day}`,
      source: source.id,
      title: query,
      summary: news.slice(0, 3).map((n) => n.title).join(' · '),
      link: news[0]?.url || `https://trends.google.com/trends/explore?q=${encodeURIComponent(query)}&geo=${geo}`,
      published,
      image: inner(block, 'ht:picture') || null,
      meta: { type: 'trends', geo, traffic: parseTraffic(inner(block, 'ht:approx_traffic')), news: news.slice(0, 5) },
    });
  }
  return out;
}

export async function fetchTrends(source, opts = {}) {
  const url = `${ENDPOINT}?geo=${encodeURIComponent(source.geo ?? 'US')}`;
  return parseTrends(await getText(url, opts), source);
}
