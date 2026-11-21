import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { score } from '../src/score.js';
import { openStore } from '../src/store.js';
import { selectEvents, topOfDay, ownerDay } from '../src/select-run.js';
import { sourceMetaOf, eventMeta } from '../src/issue.js';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const first = new Date(NOW - 2 * 3.6e6).toISOString(); // 2 ч назад → свежесть 10
const ev = (title, o = {}) => ({ title, firstSeen: first, independentSources: 1, ...o });
const sc = (e) => score(e, { now: NOW });

// --- strong science examples: 60–80 ---
test('a science breakthrough: Nature, one source but leading → 60–80', () => {
  const r = sc(ev('Scientists discover first-ever room-temperature superconductor', { category: 'science', authority: true }));
  assert.ok(r.score >= 60 && r.score <= 80, `score ${r.score}`);
});

test('a space record: 2 sources → 60–80', () => {
  const r = sc(ev('NASA впервые посадила аппарат на обратной стороне Меркурия — рекорд', { category: 'space', independentSources: 2 }));
  assert.ok(r.score >= 60 && r.score <= 80, `score ${r.score}`);
});

test('AI beat doctors: 2 sources, tech → 60–80', () => {
  const r = sc(ev('ИИ превзошёл рентгенологов в диагностике рака — прорыв в медицине', { category: 'health', independentSources: 2 }));
  assert.ok(r.score >= 60 && r.score <= 80, `score ${r.score}`);
});

test('a marker without confirmation (1 non-authoritative source) weighs less', () => {
  const lone = sc(ev('Breakthrough battery lasts a million cycles', { category: 'tech' }));
  const two = sc(ev('Breakthrough battery lasts a million cycles', { category: 'tech', independentSources: 2 }));
  assert.ok(lone.score < 40, `score ${lone.score}`);
  assert.ok(two.score >= 60, `score ${two.score}`);
});

// --- junk ---
test('junk: smartphone review, discount, review → low', () => {
  for (const [t, cat] of [
    ['Обзор нового смартфона: рекорд автономности и впервые топовая камера', 'tech'],
    ['Best laptop deals: record discounts on first-ever sale', 'tech'],
    ['Hands-on review: the breakthrough headphones you should buy', 'tech'],
  ]) {
    const r = sc(ev(t, { category: cat, independentSources: 2, authority: true }));
    assert.ok(r.score < 40, `${t}: ${r.score}`);
    assert.ok(r.reasons.some((x) => x.includes('реклама/обзор')));
  }
});

test('routine science without a marker does not reach the threshold of 40 with one source', () => {
  assert.ok(sc(ev('New paper studies soil bacteria in Norway', { category: 'science' })).score < 40);
});

test('without category the score is unchanged (world gets no «вау» bonuses)', () => {
  const a = sc(ev('Record breakthrough first time', {}));
  const b = sc(ev('Record breakthrough first time', { category: 'world' }));
  assert.equal(a.score, b.score);
  assert.equal(a.reasons.length, b.reasons.length);
});

test('«вау» markers are taken only from the headline, not the description', () => {
  const r = sc(ev('ESA Open Days 2026', { category: 'space', authority: true, summary: 'Discover the first-ever record breakthrough' }));
  assert.ok(r.score < 40, `score ${r.score}`);
});

test('eventMeta: category by the majority of the cluster feeds; authority — any', () => {
  const meta = sourceMetaOf([{ id: 'bbc', category: 'world' }, { id: 'dw', category: 'world' }, { id: 'ars', category: 'tech' }, { id: 'nature', category: 'science', authority: true }]);
  const c = (...ids) => ({ sources: ids.map((source) => ({ source })) });
  assert.deepEqual(eventMeta(c('bbc', 'dw', 'ars'), meta), { category: 'world', authority: false });
  assert.deepEqual(eventMeta(c('ars', 'nature'), meta), { category: 'science', authority: true }); // a tie → priority order
  assert.deepEqual(eventMeta(c('zzz'), meta), { category: undefined, authority: false });
});

// --- top of the day ---
const T = (id, score, iso, status = 'отобрано', category = 'accidents') => ({ id, score, first_seen: iso, status, category });

test('ownerDay: calendar day in UTC+7', () => {
  assert.equal(ownerDay('2026-10-28T16:59:00Z'), '2026-10-28');
  assert.equal(ownerDay('2026-10-28T17:00:00Z'), '2026-10-29');
  assert.equal(ownerDay(null), null);
});

test('topOfDay: the best N per day above the threshold; days are independent; rejected ones do not count', () => {
  const evs = [
    T('a', 70, '2026-10-28T01:00:00Z', 'отобрано', 'war'), T('b', 65, '2026-10-28T02:00:00Z', 'отобрано', 'science'),
    T('c', 50, '2026-10-28T03:00:00Z', 'отобрано', 'tech'), T('d', 45, '2026-10-28T04:00:00Z', 'отобрано', 'economy'),
    T('low', 39, '2026-10-28T05:00:00Z'), T('rej', 90, '2026-10-28T05:00:00Z', 'отклонено'),
    T('e', 41, '2026-10-28T06:00:00Z', 'отобрано', 'sport'),
    T('next', 42, '2026-10-28T18:00:00Z', 'отобрано', 'tech'), // already the 29th in UTC+7
  ];
  // minimum 3 outside politics: 'a' (politics) displaced by 'd' (economy)
  const top = topOfDay(evs, { min: 40, perDay: 3, tzHours: 7 });
  assert.deepEqual([...top].sort(), ['b', 'c', 'd', 'next']);
});

test('select: top_of_day and category in the database, idempotent', () => {
  const s = openStore(join(mkdtempSync(join(tmpdir(), 'top-')), 'news.db'));
  const rec = (id, source, title, pub) => ({ id, source, title, summary: 'Кратко', link: `https://example.com/${id}`, published: pub });
  const items = [
    rec('1', 'nature', 'Scientists discover first-ever quantum memory that lasts a year', '2026-10-28T10:00:00Z'),
    rec('2', 'bbc', 'Review: best sofa deals this week', '2026-10-28T10:05:00Z'),
  ];
  s.addItems(items, { now: '2026-10-28T10:10:00.000Z' });
  const sourceMeta = sourceMetaOf([{ id: 'nature', category: 'science', authority: true }, { id: 'bbc', category: 'world' }]);
  const cfg = JSON.parse(readFileSync(new URL('../src/score.config.json', import.meta.url), 'utf8'));
  const run = () => selectEvents(s, { now: new Date(NOW), sourceMeta, scoreConfig: { ...cfg, owner_feed_top_per_day: 1 } });
  const r = run();
  run();
  assert.equal(r.top, 1);
  const all = s.list();
  const q = all.find((e) => e.title.includes('quantum'));
  assert.equal(q.top_of_day, 1);
  assert.equal(q.category, 'science');
  assert.ok(q.score >= 40);
  assert.equal(all.filter((e) => e.top_of_day === 1).length, 1);
  s.close();
});

// --- feed format ---
test('sources.json: feed format', () => {
  const { sources } = JSON.parse(readFileSync(new URL('../sources.json', import.meta.url), 'utf8'));
  const CATS = ['world', 'science', 'tech', 'space', 'health', 'economy', 'war', 'russia', 'accidents', 'society', 'celebrity', 'sport'];
  assert.ok(sources.length >= 19);
  const ids = new Set();
  for (const s of sources) {
    assert.ok(s.id && !ids.has(s.id), `id ${s.id}`);
    ids.add(s.id);
    assert.ok(CATS.includes(s.category), `${s.id}: category`);
    assert.ok(s.group, `${s.id}: group`);
    assert.match(s.url, /^https:\/\//);
    assert.ok(['ru', 'en'].includes(s.lang), `${s.id}: lang`);
    assert.ok(s.name);
    if ('authority' in s) assert.equal(s.authority, true);
  }
  assert.ok(sources.filter((s) => s.category !== 'world').length >= 12);
  // one outlet — one group: different hosts across groups are not checked, but bbc must share its group
  assert.equal(sources.find((s) => s.id === 'bbc-world').group, sources.find((s) => s.id === 'bbc-russian').group);
  for (const id of ['nature', 'science-news', 'nasa']) assert.equal(sources.find((s) => s.id === id).authority, true);
});

test('score.config.json: the owner feed thresholds and category weights', () => {
  const c = JSON.parse(readFileSync(new URL('../src/score.config.json', import.meta.url), 'utf8'));
  assert.equal(c.owner_feed_min, 40);
  assert.equal(c.owner_feed_top_per_day, 7);
  for (const k of ['world', 'science', 'tech', 'space', 'health', 'economy']) assert.equal(typeof c.category_weights[k], 'number');
  assert.ok(c.wow.markers.length && c.wow.stop.length);
});
