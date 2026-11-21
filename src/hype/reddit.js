import { parseFeed } from '../collect.js';
import { HttpError, getText, iso, pause } from './http.js';

export const SUBS = ['worldnews', 'news', 'interestingasfuck', 'nextfuckinglevel', 'PublicFreakout', 'technology', 'space', 'Damnthatsinteresting'];

/** hot.json: Reddit listing → records with score and comment count. Pinned posts are skipped. */
export function parseRedditJson(text, source, { minScore = 0 } = {}) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const out = [];
  for (const ch of data?.data?.children ?? []) {
    const d = ch?.data;
    if (!d?.id || !d.title || d.stickied) continue;
    const score = Number(d.score) || 0;
    if (score < minScore) continue;
    const thumb = /^https?:\/\//.test(d.thumbnail ?? '') ? d.thumbnail : null;
    out.push({
      id: `${source.id}:${d.id}`,
      source: source.id,
      title: String(d.title).replace(/\s+/g, ' ').trim(),
      summary: `r/${d.subreddit}: ${score} очков, ${Number(d.num_comments) || 0} комментариев`,
      link: `https://www.reddit.com${d.permalink ?? `/comments/${d.id}`}`,
      published: iso(Number(d.created_utc) * 1000),
      image: thumb,
      meta: { type: 'reddit', sub: d.subreddit, score, comments: Number(d.num_comments) || 0, ratio: d.upvote_ratio ?? null },
    });
  }
  return out;
}

/** hot.rss (Atom) — a fallback when .json is closed: the feed has no points or comments, the order = the hot ranking. */
export function parseRedditRss(xml, source, sub) {
  return parseFeed(xml, source).map((i, rank) => ({
    ...i,
    summary: `r/${sub}: место ${rank + 1} в hot`,
    meta: { type: 'reddit', sub, score: null, comments: null, rank: rank + 1 },
  }));
}

/**
 * Hot across a list of subreddits: one request at a time, a pause of pauseMs, User-Agent set in http.js.
 * 429 — this subreddit is skipped without a radar error; 403 on .json — try .rss.
 * An error (not 429) is thrown only if no subreddit answered.
 */
export async function fetchReddit(source, { fetchImpl = fetch, sleep = pause, ...opts } = {}) {
  const subs = source.subs ?? SUBS;
  const limit = source.limit ?? 25;
  const out = [];
  let ok = 0;
  let skipped429 = 0;
  let lastError = null;
  for (let i = 0; i < subs.length; i++) {
    if (i) await sleep(source.pause_ms ?? 2500);
    const base = `https://www.reddit.com/r/${subs[i]}/hot`;
    try {
      let items;
      try {
        items = parseRedditJson(await getText(`${base}.json?limit=${limit}&raw_json=1`, { fetchImpl, ...opts }), source, { minScore: source.min_score ?? 0 });
      } catch (e) {
        if (!(e instanceof HttpError) || e.status !== 403) throw e;
        await sleep(source.pause_ms ?? 2500);
        items = parseRedditRss(await getText(`${base}.rss?limit=${limit}`, { fetchImpl, ...opts }), source, subs[i]);
      }
      out.push(...items);
      ok++;
    } catch (e) {
      if (e instanceof HttpError && e.status === 429) skipped429++;
      else lastError = e;
    }
  }
  if (!ok && !skipped429 && lastError) throw lastError;
  return out;
}
