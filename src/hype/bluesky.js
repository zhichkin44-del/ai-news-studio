import { getJson, iso } from './http.js';

// searchPosts у публичного API закрыт (403 без входа), поэтому берём то, что открыто без ключа:
// getTrends (темы Bluesky с числом постов) и ленту «What's Hot» с репостами.
const TRENDS = 'https://api.bsky.app/xrpc/app.bsky.unspecced.getTrends?limit=25';
const HOT = 'https://public.api.bsky.app/xrpc/app.bsky.feed.getFeed?feed=at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot&limit=50';

export function parseTrends(json, source) {
  return (json?.trends ?? []).filter((t) => t?.displayName).map((t) => ({
    id: `${source.id}:trend:${t.topic ?? t.displayName}`,
    source: source.id,
    title: t.displayName,
    summary: t.description ?? '',
    link: t.link ? `https://bsky.app${t.link}` : `https://bsky.app/search?q=${encodeURIComponent(t.displayName)}`,
    published: iso(t.startedAt),
    image: null,
    meta: { type: 'bluesky', kind: 'trend', posts: Number(t.postCount) || 0, status: t.status ?? null, category: t.category ?? null },
  }));
}

/** Посты ленты с числом репостов не ниже minReposts. */
export function parsePosts(json, source, { minReposts = 150 } = {}) {
  const out = [];
  for (const f of json?.feed ?? []) {
    const p = f?.post;
    const text = String(p?.record?.text ?? '').replace(/\s+/g, ' ').trim();
    const reposts = Number(p?.repostCount) || 0;
    if (!p?.uri || !text || reposts < minReposts || f.reason) continue; // f.reason — это репост в ленте, не оригинал
    const rkey = p.uri.split('/').pop();
    out.push({
      id: `${source.id}:${p.uri}`,
      source: source.id,
      title: text.length > 220 ? `${text.slice(0, 217)}…` : text,
      summary: `Bluesky: ${reposts} репостов, ${Number(p.likeCount) || 0} лайков`,
      link: `https://bsky.app/profile/${p.author?.handle ?? p.author?.did}/post/${rkey}`,
      published: iso(p.record?.createdAt ?? p.indexedAt),
      image: null,
      meta: { type: 'bluesky', kind: 'post', reposts, likes: Number(p.likeCount) || 0, replies: Number(p.replyCount) || 0, lang: p.record?.langs?.[0] ?? null },
    });
  }
  return out;
}

export async function fetchBluesky(source, opts = {}) {
  const [trends, hot] = await Promise.allSettled([getJson(TRENDS, opts), getJson(HOT, opts)]);
  if (trends.status === 'rejected' && hot.status === 'rejected') throw trends.reason;
  return [
    ...(trends.status === 'fulfilled' ? parseTrends(trends.value, source) : []),
    ...(hot.status === 'fulfilled' ? parsePosts(hot.value, source, { minReposts: source.min_reposts }) : []),
  ];
}
