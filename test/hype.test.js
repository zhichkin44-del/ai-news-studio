import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTrends } from '../src/hype/google-trends.js';
import { parseRedditJson, parseRedditRss, fetchReddit } from '../src/hype/reddit.js';
import { parseTop, surges, fetchWikipedia } from '../src/hype/wikipedia.js';
import { parseTrends as parseBskyTrends, parsePosts, fetchBluesky } from '../src/hype/bluesky.js';
import { detectBursts, burstTitle, BURST_CONFIG } from '../src/hype/burst.js';
import { fetchHype, kindsOf, LOADERS } from '../src/hype/index.js';
import { parseTraffic, UA } from '../src/hype/http.js';
import { pollOnce } from '../src/radar.js';
import { score } from '../src/score.js';
import { DEFAULT_AUDIENCE } from '../src/audience.js';
import { openStore } from '../src/store.js';
import { selectEvents } from '../src/select-run.js';
import { loadSources } from '../src/collect.js';

// ---------- фикстуры форматов ----------
const TRENDS_XML = `<?xml version="1.0"?><rss xmlns:ht="https://trends.google.com/trending/rss" version="2.0"><channel><title>Daily Search Trends</title>
<item><title>oil spill brazil</title><ht:approx_traffic>2K+</ht:approx_traffic><description/><link>https://trends.google.com/trending/rss?geo=US</link>
<pubDate>Thu, 29 Oct 2026 02:50:00 -0700</pubDate><ht:picture>https://img.example/p.jpg</ht:picture>
<ht:news_item><ht:news_item_title>Oil washes up on Brazil&apos;s beaches</ht:news_item_title><ht:news_item_url>https://news.example/oil-1</ht:news_item_url><ht:news_item_source>Example</ht:news_item_source></ht:news_item>
<ht:news_item><ht:news_item_title>Cleanup begins</ht:news_item_title><ht:news_item_url>https://news.example/oil-2</ht:news_item_url><ht:news_item_source>Other</ht:news_item_source></ht:news_item></item>
<item><title>lions depth chart</title><ht:approx_traffic>1,5M+</ht:approx_traffic><pubDate>Thu, 29 Oct 2026 02:50:00 -0700</pubDate></item></channel></rss>`;

const REDDIT_JSON = JSON.stringify({ data: { children: [
  { data: { id: 'a1', title: 'Oil washing up on  Brazil beaches', score: 41200, num_comments: 2300, created_utc: 1792000000, permalink: '/r/worldnews/comments/a1/oil/', subreddit: 'worldnews', upvote_ratio: 0.94, thumbnail: 'https://t.example/x.jpg' } },
  { data: { id: 'a2', title: 'Pinned rules', score: 9, num_comments: 1, created_utc: 1792000000, permalink: '/r/worldnews/comments/a2/', subreddit: 'worldnews', stickied: true } },
  { data: { id: 'a3', title: 'Low score post', score: 12, num_comments: 0, created_utc: 1792000000, permalink: '/r/worldnews/comments/a3/', subreddit: 'worldnews', thumbnail: 'self' } },
] } });

const REDDIT_ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>t3_x1</id><title>Whale on the beach</title><link href="https://www.reddit.com/r/space/comments/x1/whale/"/><updated>2026-10-29T08:00:00+00:00</updated><content type="html">&lt;p&gt;text&lt;/p&gt;</content></entry>
<entry><id>t3_x2</id><title>Second</title><link href="https://www.reddit.com/r/space/comments/x2/second/"/><updated>2026-10-29T08:10:00+00:00</updated></entry></feed>`;

const WIKI_TOP = (rows) => ({ items: [{ articles: rows.map(([article, views], i) => ({ article, views, rank: i + 1 })) }] });

const BSKY_TRENDS = { trends: [
  { topic: 'abc', displayName: 'Oil on Brazil beaches', description: 'Videos of oil', link: '/profile/did:plc:x/feed/abc', startedAt: '2026-10-29T08:00:00Z', postCount: 900, status: 'trending', category: 'news' },
  { topic: 'no', description: 'без названия' },
] };
const BSKY_FEED = { feed: [
  { post: { uri: 'at://did:plc:a/app.bsky.feed.post/3k1', author: { handle: 'a.bsky.social' }, record: { text: 'Big  post', createdAt: '2026-10-29T07:00:00Z', langs: ['en'] }, repostCount: 400, likeCount: 2000, replyCount: 30 } },
  { post: { uri: 'at://did:plc:b/app.bsky.feed.post/3k2', author: { handle: 'b.bsky.social' }, record: { text: 'small', createdAt: '2026-10-29T07:00:00Z' }, repostCount: 3 } },
  { post: { uri: 'at://did:plc:c/app.bsky.feed.post/3k3', author: { handle: 'c.bsky.social' }, record: { text: 'reposted by someone', createdAt: '2026-10-29T07:00:00Z' }, repostCount: 900 }, reason: { $type: 'repost' } },
] };

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

// ---------- разбор форматов ----------
test('parseTraffic: 100+, 2K+, 1,5M+', () => {
  assert.equal(parseTraffic('100+'), 100);
  assert.equal(parseTraffic('2K+'), 2000);
  assert.equal(parseTraffic('1,5M+'), 1500000);
  assert.equal(parseTraffic(''), 0);
});

test('google-trends: запрос, трафик, связанные новости, уникальная ссылка', () => {
  const items = parseTrends(TRENDS_XML, { id: 'trends-us', geo: 'US' });
  assert.equal(items.length, 2);
  const [a, b] = items;
  assert.equal(a.title, 'oil spill brazil');
  assert.equal(a.meta.traffic, 2000);
  assert.equal(a.meta.news.length, 2);
  assert.match(a.summary, /Oil washes up on Brazil's beaches · Cleanup begins/);
  assert.equal(a.link, 'https://news.example/oil-1');
  assert.equal(a.published, '2026-10-29T09:50:00.000Z');
  assert.equal(a.id, 'trends-us:oil spill brazil:2026-10-29');
  assert.equal(b.meta.traffic, 1500000);
  assert.match(b.link, /trends\.google\.com\/trends\/explore\?q=lions%20depth%20chart&geo=US/); // не общая ссылка ленты
  assert.notEqual(a.link, b.link);
});

test('reddit.json: score, комментарии, без закреплённых и ниже порога', () => {
  const src = { id: 'reddit' };
  const all = parseRedditJson(REDDIT_JSON, src);
  assert.deepEqual(all.map((i) => i.id), ['reddit:a1', 'reddit:a3']);
  assert.equal(all[0].title, 'Oil washing up on Brazil beaches');
  assert.deepEqual([all[0].meta.score, all[0].meta.comments, all[0].meta.sub], [41200, 2300, 'worldnews']);
  assert.equal(all[0].link, 'https://www.reddit.com/r/worldnews/comments/a1/oil/');
  assert.equal(all[0].published, '2026-10-14T17:46:40.000Z');
  assert.equal(all[1].image, null); // thumbnail "self" — не картинка
  assert.deepEqual(parseRedditJson(REDDIT_JSON, src, { minScore: 300 }).map((i) => i.id), ['reddit:a1']);
  assert.deepEqual(parseRedditJson('<html>blocked</html>', src), []);
});

test('reddit.rss (Atom): запасной формат без очков, порядок = место в hot', () => {
  const items = parseRedditRss(REDDIT_ATOM, { id: 'reddit' }, 'space');
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Whale on the beach');
  assert.deepEqual([items[0].meta.sub, items[0].meta.score, items[0].meta.rank, items[1].meta.rank], ['space', null, 1, 2]);
});

test('wikipedia: служебные страницы отброшены, рост против медианы', () => {
  const top = parseTop(WIKI_TOP([['Main_Page', 4e6], ['Special:Search', 8e5], ['Oil_spill', 90000], ['Steady_page', 60000], ['Small', 100]]));
  assert.deepEqual(top.map((a) => a.article), ['Oil_spill', 'Steady_page', 'Small']);
  const hist = [1, 2, 3].map(() => parseTop(WIKI_TOP([['Steady_page', 55000], ['Other', 30000], ['Filler', 20000]])));
  const rows = surges(top, hist, { minViews: 20000, ratio: 3 });
  // Oil_spill в прошлых днях не был в топе → база = порог дня (20000): 90000/20000 = 4.5; Steady_page ×1.1 — не рост
  assert.deepEqual(rows.map((r) => [r.article, r.ratio]), [['Oil_spill', 4.5]]);
  assert.deepEqual(parseTop({}), []);
});

test('wikipedia: сбор — вчера нет (404) → берём позавчера; база из предыдущих дней', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const day = url.slice(-10);
    if (day === '2026/10/28') return res(404, 'not found');
    return res(200, WIKI_TOP(day === '2026/10/27' ? [['Oil_spill', 90000], ['Steady', 50000]] : [['Steady', 50000], ['Filler', 20000]]));
  };
  const items = await fetchWikipedia({ id: 'wiki-en', project: 'en.wikipedia', baseline_days: 2, min_views: 20000, ratio: 3 }, { fetchImpl, sleep: async () => {}, now: new Date('2026-10-29T10:00:00Z') });
  assert.equal(urls.length, 4); // 28 (404), 27, 26, 25
  assert.deepEqual(items.map((i) => i.title), ['Oil spill']);
  assert.equal(items[0].meta.day, '2026-10-27');
  assert.equal(items[0].link, 'https://en.wikipedia.org/wiki/Oil_spill');
});

test('wikipedia: 429 — пропуск без ошибки; 429 в истории — считаем по имеющемуся', async () => {
  const src = { id: 'wiki-en', project: 'en.wikipedia', baseline_days: 3, min_views: 20000, ratio: 3 };
  const opts = { sleep: async () => {}, now: new Date('2026-10-29T10:00:00Z') };
  assert.deepEqual(await fetchWikipedia(src, { ...opts, fetchImpl: async () => res(429, '') }), []);
  const fetchImpl = async (url) => (url.slice(-10) === '2026/10/28' ? res(200, WIKI_TOP([['Oil_spill', 90000]])) : url.slice(-10) === '2026/10/27' ? res(200, WIKI_TOP([['Filler', 20000]])) : res(429, ''));
  const items = await fetchWikipedia(src, { ...opts, fetchImpl });
  assert.deepEqual(items.map((i) => i.title), ['Oil spill']);
});

test('bluesky: тренды и посты с большим числом репостов', () => {
  const t = parseBskyTrends(BSKY_TRENDS, { id: 'bluesky' });
  assert.equal(t.length, 1);
  assert.deepEqual([t[0].title, t[0].meta.posts, t[0].published, t[0].link], ['Oil on Brazil beaches', 900, '2026-10-29T08:00:00.000Z', 'https://bsky.app/profile/did:plc:x/feed/abc']);
  const p = parsePosts(BSKY_FEED, { id: 'bluesky' }, { minReposts: 150 });
  assert.equal(p.length, 1); // 3 репоста — мало, чужой репост в ленте — не оригинал
  assert.deepEqual([p[0].title, p[0].meta.reposts, p[0].link], ['Big post', 400, 'https://bsky.app/profile/a.bsky.social/post/3k1']);
});

test('bluesky: упал один запрос — второй работает; упали оба — ошибка', async () => {
  const ok = async (url) => (url.includes('getTrends') ? res(500, 'x') : res(200, BSKY_FEED));
  assert.equal((await fetchBluesky({ id: 'bluesky', min_reposts: 150 }, { fetchImpl: ok })).length, 1);
  await assert.rejects(fetchBluesky({ id: 'bluesky' }, { fetchImpl: async () => res(403, 'no') }), /HTTP 403/);
});

// ---------- Reddit: темп и 429 ----------
test('reddit: по одному запросу, пауза между ними, User-Agent; 429 — пропуск без ошибки', async () => {
  const calls = [];
  const pauses = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, ua: init.headers['user-agent'] });
    return url.includes('/r/news/') ? res(429, '') : res(200, REDDIT_JSON);
  };
  const src = { id: 'reddit', subs: ['worldnews', 'news', 'space'], pause_ms: 2500, min_score: 300 };
  const items = await fetchReddit(src, { fetchImpl, sleep: async (ms) => pauses.push(ms) });
  assert.equal(calls.length, 3);
  assert.deepEqual(pauses, [2500, 2500]);
  assert.ok(calls.every((c) => c.ua === UA && c.ua.length > 10));
  assert.equal(items.length, 2); // worldnews и space; news пропущен (429)
});

test('reddit: 429 везде — пустой результат, не ошибка радара', async () => {
  const items = await fetchReddit({ id: 'reddit', subs: ['a', 'b'] }, { fetchImpl: async () => res(429, ''), sleep: async () => {} });
  assert.deepEqual(items, []);
});

test('reddit: .json закрыт (403) — берём .rss; всё сломано (500) — ошибка', async () => {
  const urls = [];
  const fetchImpl = async (url) => { urls.push(url); return url.includes('.json') ? res(403, '') : res(200, REDDIT_ATOM); };
  const items = await fetchReddit({ id: 'reddit', subs: ['space'] }, { fetchImpl, sleep: async () => {} });
  assert.equal(items.length, 2);
  assert.match(urls[1], /\/r\/space\/hot\.rss/);
  await assert.rejects(fetchReddit({ id: 'reddit', subs: ['a'] }, { fetchImpl: async () => res(500, ''), sleep: async () => {} }), /HTTP 500/);
});

// ---------- детектор всплеска ----------
const T = Date.parse('2026-10-29T12:00:00Z');
const ago = (min) => new Date(T - min * 60000).toISOString();
let seq = 0;
const it = (source, title, minAgo, summary = '') => ({ id: `${source}:${++seq}`, source, title, summary, link: `https://x/${seq}`, published: ago(minAgo), first_seen: ago(Math.max(0, minAgo - 1)) });
const KINDS = { reddit: 'reddit', 'trends-us': 'trends' };
const CFG = { ...BURST_CONFIG, aliases: { ...BURST_CONFIG.aliases, brazil: 'бразилия' } };

// фон: 24 часа обычных новостей, разные темы; первая запись — 23 часа назад (история есть)
const background = () => Array.from({ length: 48 }, (_, i) => it(['tass', 'ria', 'lenta'][i % 3], `Фоновая тема номер${i} про ${['бюджет', 'погоду', 'футбол', 'курорт'][i % 4]}${i}`, 1380 - i * 28));

test('burst: СМИ + Reddit про одну тему (на разных языках) → всплеск', () => {
  const items = [
    ...background(),
    it('tass', 'Нефть вынесло на пляжи Бразилии', 40),
    it('ria', 'Нефть у берегов Бразилии: пляжи закрыты', 30),
    it('lenta', 'Пятна нефти на пляжах Бразилии', 20),
    it('reddit', 'Oil washing up on Brazil beaches', 35),
    it('reddit', 'Oil spill reaches Brazil beaches, people film it', 25),
  ];
  const bursts = detectBursts(items, { now: T, kinds: KINDS, config: CFG });
  assert.equal(bursts.length, 1);
  const [b] = bursts;
  assert.deepEqual(b.types, ['media', 'reddit']);
  assert.ok(b.ratio >= 5, `ratio ${b.ratio}`);
  assert.ok(['нефт', 'пляж', 'бразил'].every((t) => b.tokens.includes(t)), b.tokens.join());
  assert.equal(b.mediaItems.length, 3);
  assert.equal(b.signalItems.length, 2);
  assert.equal(burstTitle(b, CFG), 'Нефть вынесло на пляжи Бразилии'); // из СМИ (не из Reddit); все три покрывают тему поровну — берётся самая ранняя
});

test('burst: порог x3 из конфига — нефть у берегов нескольких континентов (Reddit + Trends + СМИ) даёт всплеск, одиночный тренд — нет', () => {
  assert.equal(BURST_CONFIG.min_ratio, 3);
  assert.equal(BURST_CONFIG.min_types, 2);
  // у темы есть история (≈1 упоминание в час), поэтому рост около x4: при x5 такой всплеск терялся
  const history = Array.from({ length: 24 }, (_, i) => it(['tass', 'ria', 'lenta'][i % 3], `Нефть и пляж: курорты ждут туристов ${i}`, 120 + i * 50));
  const oil = [
    ...background(),
    ...history,
    it('tass', 'Нефть выбросило на пляжи Африки и Азии', 50),
    it('ria', 'Нефть у берегов Африки: пляжи закрыты', 35),
    it('reddit', 'Oil washing ashore on beaches of three continents', 40),
    it('trends-us', 'oil beaches continents', 30, 'Oil spill on beaches in Africa and Asia'),
  ];
  const [b] = detectBursts(oil, { now: T, kinds: KINDS, config: CFG });
  assert.ok(b, 'всплеск найден');
  assert.deepEqual(b.types, ['media', 'reddit', 'trends']);
  assert.ok(b.ratio >= 3 && b.ratio < 5, `ratio ${b.ratio}`); // при прежнем x5 не нашёлся бы
  assert.equal(detectBursts(oil, { now: T, kinds: KINDS, config: { ...CFG, min_ratio: 5 } }).length, 0);
  const lone = [...background(), it('trends-us', 'oil beaches continents', 30, 'Oil on beaches'), it('trends-us', 'oil continents spill', 20, 'Oil on beaches'), it('trends-us', 'oil beaches spill', 10, 'Oil on beaches')];
  assert.deepEqual(detectBursts(lone, { now: T, kinds: KINDS, config: CFG }), []);
});

test('burst: один вид источников — не всплеск (только СМИ или только Reddit)', () => {
  const media = [...background(), it('tass', 'Нефть вынесло на пляжи Бразилии', 40), it('ria', 'Нефть у берегов Бразилии: пляжи закрыты', 30), it('lenta', 'Пятна нефти на пляжах Бразилии', 20)];
  assert.deepEqual(detectBursts(media, { now: T, kinds: KINDS, config: CFG }), []);
  const reddit = [...background(), ...[40, 30, 20].map((m) => it('reddit', `Oil on Brazil beaches ${'x'.repeat(m % 7)}`, m))];
  assert.deepEqual(detectBursts(reddit, { now: T, kinds: KINDS, config: CFG }), []);
});

test('burst: ровный фон (3 в час и раньше) — не всплеск; 2 упоминания — мало', () => {
  const steady = Array.from({ length: 72 }, (_, i) => it(['tass', 'ria', 'lenta'][i % 3], `Курс доллара на торгах ${i}`, Math.floor(i / 3) * 60 + 5));
  const mix = [...steady, it('reddit', 'Курс доллара снова растёт', 10), it('reddit', 'Курс доллара новый рекорд', 8)];
  assert.deepEqual(detectBursts(mix, { now: T, kinds: KINDS, config: CFG }), []);
  const few = [...background(), it('tass', 'Нефть вынесло на пляжи Бразилии', 40), it('reddit', 'Oil washing up on Brazil beaches', 35)];
  assert.deepEqual(detectBursts(few, { now: T, kinds: KINDS, config: CFG }), []);
});

test('burst: тема уже в топе — не новая; база моложе min_history_hours — всплесков нет', () => {
  const items = [...background(), it('tass', 'Нефть вынесло на пляжи Бразилии', 40), it('ria', 'Нефть у берегов Бразилии: пляжи закрыты', 30), it('lenta', 'Пятна нефти на пляжах Бразилии', 20), it('reddit', 'Oil washing up on Brazil beaches', 35), it('reddit', 'Oil spill reaches Brazil beaches', 25)];
  assert.equal(detectBursts(items, { now: T, kinds: KINDS, config: CFG }).length, 1);
  assert.deepEqual(detectBursts(items, { now: T, kinds: KINDS, config: CFG, known: ['Нефть вынесло на пляжи Бразилии'] }), []);
  const young = items.slice(48).map((i) => ({ ...i, first_seen: ago(5) }));
  assert.deepEqual(detectBursts(young, { now: T, kinds: KINDS, config: CFG }), []);
});

test('burst: пара независимых сигналов без СМИ (Trends + Reddit) — всплеск, заголовок из сигнала', () => {
  const items = [...background(), it('trends-us', 'whale beach stranded', 30, 'Giant whale stranded on beach'), it('reddit', 'Giant whale stranded on beach, locals try to help', 25), it('reddit', 'Whale stranded again on a beach near town', 15), it('trends-us', 'stranded whale', 10)];
  const [b] = detectBursts(items, { now: T, kinds: KINDS, config: CFG });
  assert.deepEqual(b.types, ['reddit', 'trends']);
  assert.equal(b.mediaItems.length, 0);
  assert.match(burstTitle(b, CFG), /whale/i);
});

test('burst: тема из одного общего слова не всплеск (min_tokens)', () => {
  const items = [...background(), it('tass', 'Депутат высказался', 40), it('ria', 'Министр высказался', 30), it('lenta', 'Артист высказался', 20), it('reddit', 'Mayor высказался', 35)];
  assert.deepEqual(detectBursts(items, { now: T, kinds: KINDS, config: CFG }), []);
  assert.equal(detectBursts(items, { now: T, kinds: KINDS, config: { ...CFG, min_tokens: 1 } }).length, 1);
});

// ---------- очки хайпа ----------
test('score: хайп добавляет очки по весам audience.json, без хайпа — как раньше', () => {
  const ev = { title: 'Нейтральная новость без тем', firstSeen: '2026-10-01T00:00:00Z', independentSources: 2 };
  const now = Date.parse('2026-10-29T12:00:00Z');
  const base = score(ev, { now });
  const hyped = score({ ...ev, hype: { types: 3, ratio: 25 } }, { now });
  const h = DEFAULT_AUDIENCE.hype;
  assert.equal(hyped.score - base.score, Math.min(h.max_points, h.base + h.per_type + h.big_bonus));
  assert.match(hyped.reasons.join('|'), /хайп: всплеск ×25, видов источников 3/);
  const custom = { ...DEFAULT_AUDIENCE, hype: { ...h, base: 5, per_type: 0, big_bonus: 0 } };
  assert.equal(score({ ...ev, hype: { types: 2, ratio: 6 } }, { now, audience: custom }).score - base.score, 5);
});

// ---------- радар ----------
test('радар: пустой ответ источника хайпа — не ошибка; every_min держит ритм; baseline по polls', async () => {
  const store = openStore(':memory:');
  const log = join(mkdtempSync(join(tmpdir(), 'hype-')), 'e.log');
  const hype = { id: 'reddit', type: 'hype', kind: 'reddit', every_min: 10 };
  const feed = { id: 'tass' };
  const loader = async (s) => (s.type === 'hype' ? [] : [{ id: 'tass:1', source: 'tass', title: 'Т', link: 'https://x/1', published: null }]);
  const t0 = Date.parse('2026-10-29T10:00:00Z');
  let r = await pollOnce([hype, feed], { store, loader, logPath: log, now: () => new Date(t0) });
  assert.deepEqual(r.map((x) => [x.source, x.ok]), [['reddit', true], ['tass', true]]);
  r = await pollOnce([hype, feed], { store, loader, logPath: log, now: () => new Date(t0 + 120000) });
  assert.deepEqual(r.map((x) => x.source), ['tass']); // reddit молчит до +10 мин
  r = await pollOnce([hype, feed], { store, loader, logPath: log, now: () => new Date(t0 + 11 * 60000) });
  assert.deepEqual(r.map((x) => x.source), ['reddit', 'tass']);
  // пустая лента СМИ по-прежнему ошибка
  r = await pollOnce([feed], { store, loader: async () => [], logPath: log, now: () => new Date(t0 + 20 * 60000) });
  assert.equal(r[0].ok, false);
});

test('радар: записи хайпа сохраняют meta (очки, комментарии) в items', async () => {
  const store = openStore(':memory:');
  const src = { id: 'reddit', type: 'hype', kind: 'reddit' };
  await pollOnce([src], { store, loader: async () => parseRedditJson(REDDIT_JSON, src), logPath: join(mkdtempSync(join(tmpdir(), 'hype-')), 'e.log') });
  const row = store.itemsSince('2000').find((r) => r.id === 'reddit:a1');
  assert.deepEqual([JSON.parse(row.meta).score, JSON.parse(row.meta).comments], [41200, 2300]);
});

test('sources.json: хайп-источники описаны полно, у каждого есть загрузчик', async () => {
  const hype = (await loadSources()).filter((s) => s.type === 'hype');
  assert.deepEqual(new Set(hype.map((s) => s.kind)), new Set(['trends', 'reddit', 'wikipedia', 'bluesky']));
  for (const s of hype) assert.ok(LOADERS[s.kind] && s.every_min > 0, s.id);
  assert.equal(Object.keys(kindsOf(hype)).length, hype.length);
  assert.deepEqual(hype.find((s) => s.id === 'reddit').subs.sort(), ['Damnthatsinteresting', 'PublicFreakout', 'interestingasfuck', 'news', 'nextfuckinglevel', 'space', 'technology', 'worldnews']);
  await assert.rejects(async () => fetchHype({ kind: 'tiktok' }), /неизвестный вид/);
});

// ---------- отбор: событие из всплеска ----------
const NOW = new Date('2026-10-29T12:00:00Z');
const GROUPS = { tass: 'tass', ria: 'ria', lenta: 'lenta' };
function seed(store, rows) {
  for (const r of rows) store.addItems([{ id: r.id, source: r.source, title: r.title, summary: r.summary ?? '', link: r.link, published: r.published, meta: r.meta }], { now: r.first_seen });
}

test('select: всплеск СМИ + Reddit → событие hype=1 с пик-очками; ссылки сигналов только в базе', () => {
  const store = openStore(':memory:');
  seed(store, [
    ...background(),
    it('tass', 'Нефть вынесло на пляжи Бразилии', 40),
    it('ria', 'Нефть у берегов Бразилии: пляжи закрыты', 30),
    it('lenta', 'Пятна нефти на пляжах Бразилии', 20),
    it('reddit', 'Oil washing up on Brazil beaches', 35),
    it('reddit', 'Oil spill reaches Brazil beaches', 25),
  ]);
  const r = selectEvents(store, { now: NOW, groups: GROUPS, kinds: KINDS, burstConfig: CFG });
  assert.equal(r.hype, 1);
  const ev = store.list().filter((e) => e.hype);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].title, 'Нефть вынесло на пляжи Бразилии');
  assert.equal(ev[0].independent_sources, 4); // 3 издателя + Reddit
  assert.ok(ev[0].reasons.some((x) => x.startsWith('хайп: всплеск')));
  assert.ok(ev[0].peak_score >= 40);
  assert.ok(ev[0].sources.some((s) => s.source === 'reddit')); // сверка фактов: сигнал в записи события
  assert.ok(['отобрано', 'новое'].includes(ev[0].status));
  // повтор не плодит событий; признак не снимается
  selectEvents(store, { now: NOW, groups: GROUPS, kinds: KINDS, burstConfig: CFG });
  assert.equal(store.list().filter((e) => e.hype).length, 1);
  assert.equal(store.list().filter((e) => e.title.includes('нефт') || e.title.includes('Нефть')).length, 1);
});

test('select: сигналы сами по себе не публикуются — только Reddit (один вид) событий не даёт', () => {
  const store = openStore(':memory:');
  seed(store, [...background(), ...[40, 30, 20, 10].map((m) => it('reddit', `Oil washing up on Brazil beach number ${m}`, m))]);
  const before = selectEvents(store, { now: NOW, groups: GROUPS, kinds: KINDS, burstConfig: CFG });
  assert.equal(before.hype, 0);
  assert.ok(!store.list().some((e) => /Oil washing/.test(e.title)));
});

test('select: Trends + Reddit без СМИ → кандидат hype=1, заголовок из сигнала', () => {
  const store = openStore(':memory:');
  seed(store, [...background(), it('trends-us', 'whale beach stranded', 30, 'Giant whale stranded on beach'), it('reddit', 'Giant whale stranded on beach, locals try to help', 25), it('reddit', 'Whale stranded again on a beach near town', 15), it('trends-us', 'stranded whale', 10)]);
  selectEvents(store, { now: NOW, groups: GROUPS, kinds: KINDS, burstConfig: CFG });
  const ev = store.list().filter((e) => e.hype);
  assert.equal(ev.length, 1);
  assert.match(ev[0].title, /whale/i);
  assert.ok(ev[0].sources.every((s) => ['reddit', 'trends-us'].includes(s.source)));
});
