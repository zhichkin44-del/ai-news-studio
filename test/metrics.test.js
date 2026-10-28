import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, percentile, formatMetrics, parseArgs } from '../src/metrics.js';
import { openStore } from '../src/store.js';

const NOW = new Date('2026-10-28T12:00:00Z');
const iso = (minAgo) => new Date(NOW.getTime() - minAgo * 60000).toISOString();

// published/seen — «минут назад»; delay = first_seen − published
function add(store, source, n, title, { pub, seen = pub, baseline = false, link = `https://x/${source}/${n}` }) {
  store.addItems([{ id: `${source}:${n}`, title, link, source, published: pub == null ? null : iso(pub) }], { now: iso(seen), baseline });
}

function fill() {
  const store = openStore(':memory:');
  // событие 1: Ливан — две ленты разных издателей; задержки 1 и 10 минут
  add(store, 'a', 1, 'Israel strikes Beirut suburb overnight', { pub: 31, seen: 30 });
  add(store, 'b', 1, 'Israel strikes Beirut suburb overnight, officials say', { pub: 40, seen: 30 });
  // событие 2: одиночное, свежее, задержка 2 мин
  add(store, 'a', 2, 'Volcano erupts near Reykjavik', { pub: 12, seen: 10 });
  // baseline-запись с огромной задержкой не должна портить замер
  add(store, 'b', 2, 'Old story about tariffs and trade', { pub: 3000, seen: 100, baseline: true });
  // повтор: тот же link под другим id
  add(store, 'a', 3, 'Volcano erupts near Reykjavik today', { pub: 11, seen: 9, link: 'https://x/a/2' });
  // лента c: только старое
  add(store, 'c', 1, 'Completely unrelated archive piece', { pub: 700, seen: 650 });
  for (const s of ['a', 'b']) store.recordPoll(s, { ok: true, count: 3 }, iso(5));
  store.recordPoll('b', { ok: false, error: 'HTTP 500' }, iso(4));
  store.recordPoll('c', { ok: true, count: 1 }, iso(5));
  return store;
}

const SOURCES = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];

test('percentile по ближайшему рангу', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5], 90), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
});

test('счётчики событий, дублей и независимых источников', () => {
  const m = computeMetrics(fill(), { now: NOW, sources: SOURCES });
  assert.equal(m.items, 6);
  assert.equal(m.events, 4); // Ливан; вулкан (2 записи); тарифы; архив
  assert.equal(m.multi_source_share, 0.25);
  assert.equal(m.duplicates_merged_share, round3(2 / 6)); // 6 записей → 4 события
  assert.equal(m.unique_items_share, round3(5 / 6)); // один повторный link
  assert.equal(m.events_by_feed.a, 2);
  assert.equal(m.events_by_feed.b, 2);
});

function round3(x) { return Math.round(x * 1000) / 1000; }

test('задержка: baseline и записи без даты не считаются', () => {
  const m = computeMetrics(fill(), { now: NOW, sources: SOURCES });
  // замеряются: a1 (1 мин), b1 (10 мин), a2 (2 мин), a3 (2 мин), c1 (50 мин)
  assert.equal(m.latency.measured, 5);
  assert.equal(m.latency.median_sec, 120);
  assert.equal(m.latency.p90_sec, 3000);
  assert.equal(m.latency.within_5min, 0.6);
  const fa = m.feeds.find((f) => f.source === 'a');
  assert.equal(fa.latency.within_5min, 1);
});

test('проблемные ленты: ошибки и отсутствие свежих за 6 часов', () => {
  const m = computeMetrics(fill(), { now: NOW, sources: SOURCES });
  const by = Object.fromEntries(m.problem_feeds.map((f) => [f.source, f.problem]));
  assert.deepEqual(by, { b: 'ошибки', c: 'нет свежих за 6 ч', d: 'нет свежих за 6 ч' });
  const fb = m.feeds.find((f) => f.source === 'b');
  assert.equal(fb.error_rate, 0.5);
  assert.equal(m.feeds.find((f) => f.source === 'a').problem, null);
});

test('период ограничивает выборку', () => {
  const m = computeMetrics(fill(), { now: NOW, hours: 1, sources: SOURCES });
  assert.equal(m.items, 4); // впервые увиденные за час: a1, b1, a2, a3 (30, 30, 10, 9 мин назад); b2 (100) и c1 (650) вне окна
  assert.equal(m.period_hours, 1);
});

test('пустая база не падает', () => {
  const m = computeMetrics(openStore(':memory:'), { now: NOW, sources: SOURCES });
  assert.equal(m.events, 0);
  assert.equal(m.multi_source_share, null);
  assert.equal(m.problem_feeds.length, 4);
  assert.ok(formatMetrics(m).includes('Проблемные ленты'));
});

test('parseArgs', () => {
  assert.equal(parseArgs([]).hours, 24);
  assert.equal(parseArgs(['--hours', '72']).hours, 72);
  assert.throws(() => parseArgs(['--hours', '0']));
});
