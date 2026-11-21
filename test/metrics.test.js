import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, percentile, formatMetrics, parseArgs } from '../src/metrics.js';
import { openStore } from '../src/store.js';

const NOW = new Date('2026-10-28T12:00:00Z');
const iso = (minAgo) => new Date(NOW.getTime() - minAgo * 60000).toISOString();

// published/seen — "minutes ago"; delay = first_seen − published
function add(store, source, n, title, { pub, seen = pub, baseline = false, link = `https://x/${source}/${n}` }) {
  store.addItems([{ id: `${source}:${n}`, title, link, source, published: pub == null ? null : iso(pub) }], { now: iso(seen), baseline });
}

function fill() {
  const store = openStore(':memory:');
  // event 1: Lebanon — two feeds from different publishers; delays of 1 and 10 minutes
  add(store, 'a', 1, 'Israel strikes Beirut suburb overnight', { pub: 31, seen: 30 });
  add(store, 'b', 1, 'Israel strikes Beirut suburb overnight, officials say', { pub: 40, seen: 30 });
  // event 2: single, fresh, delay of 2 min
  add(store, 'a', 2, 'Volcano erupts near Reykjavik', { pub: 12, seen: 10 });
  // a baseline record with a huge delay must not spoil the measurement
  add(store, 'b', 2, 'Old story about tariffs and trade', { pub: 3000, seen: 100, baseline: true });
  // repeat: the same link under a different id
  add(store, 'a', 3, 'Volcano erupts near Reykjavik today', { pub: 11, seen: 9, link: 'https://x/a/2' });
  // feed c: only old items
  add(store, 'c', 1, 'Completely unrelated archive piece', { pub: 700, seen: 650 });
  for (const s of ['a', 'b']) store.recordPoll(s, { ok: true, count: 3 }, iso(5));
  store.recordPoll('b', { ok: false, error: 'HTTP 500' }, iso(4));
  store.recordPoll('c', { ok: true, count: 1 }, iso(5));
  return store;
}

const SOURCES = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];

test('percentile by nearest rank', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5], 90), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
});

test('counters for events, duplicates and independent sources', () => {
  const m = computeMetrics(fill(), { now: NOW, sources: SOURCES });
  assert.equal(m.items, 6);
  assert.equal(m.events, 4); // Lebanon; volcano (2 records); tariffs; archive
  assert.equal(m.multi_source_share, 0.25);
  assert.equal(m.duplicates_merged_share, round3(2 / 6)); // 6 записей → 4 события
  assert.equal(m.unique_items_share, round3(5 / 6)); // один повторный link
  assert.equal(m.events_by_feed.a, 2);
  assert.equal(m.events_by_feed.b, 2);
});

function round3(x) { return Math.round(x * 1000) / 1000; }

test('hot events: 5 hot, 3 with two sources → 60%', () => {
  const store = openStore(':memory:');
  const topics = ['Missile strike hits Kharkiv', 'Earthquake rocks Chile coast', 'Explosion at Berlin station', 'Hostage crisis in Lagos', 'Oil price crash in London'];
  topics.forEach((t, n) => {
    add(store, 'a', n, t, { pub: 5 });
    if (n < 3) add(store, 'b', n, `${t}, officials say`, { pub: 4 });
  });
  add(store, 'c', 1, 'Local bakery wins award', { pub: 5 }); // not hot: topic not on the list
  const m = computeMetrics(store, { now: NOW, sources: SOURCES });
  assert.equal(m.hot_events, 5);
  assert.equal(m.hot_multi_source_share, 0.6);
  assert.equal(m.multi_source_share, 0.5); // 3 из 6 — для справки
});

test('latency: baseline and records without a date are not counted', () => {
  const m = computeMetrics(fill(), { now: NOW, sources: SOURCES });
  // measured: a1 (1 min), b1 (10 min), a2 (2 min), a3 (2 min), c1 (50 min)
  assert.equal(m.latency.measured, 5);
  assert.equal(m.latency.median_sec, 120);
  assert.equal(m.latency.p90_sec, 3000);
  assert.equal(m.latency.within_5min, 0.6);
  const fa = m.feeds.find((f) => f.source === 'a');
  assert.equal(fa.latency.within_5min, 1);
});

test('problem feeds: errors and no fresh items for 6 hours', () => {
  const m = computeMetrics(fill(), { now: NOW, sources: SOURCES });
  const by = Object.fromEntries(m.problem_feeds.map((f) => [f.source, f.problem]));
  assert.deepEqual(by, { b: 'errors', c: 'no fresh items in 6 h', d: 'no fresh items in 6 h' });
  const fb = m.feeds.find((f) => f.source === 'b');
  assert.equal(fb.error_rate, 0.5);
  assert.equal(m.feeds.find((f) => f.source === 'a').problem, null);
});

test('the period limits the sample', () => {
  const m = computeMetrics(fill(), { now: NOW, hours: 1, sources: SOURCES });
  assert.equal(m.items, 4); // first seen within the hour: a1, b1, a2, a3 (30, 30, 10, 9 min ago); b2 (100) and c1 (650) outside the window
  assert.equal(m.period_hours, 1);
});

test('an empty database does not crash', () => {
  const m = computeMetrics(openStore(':memory:'), { now: NOW, sources: SOURCES });
  assert.equal(m.events, 0);
  assert.equal(m.multi_source_share, null);
  assert.equal(m.hot_events, 0);
  assert.equal(m.hot_multi_source_share, null);
  assert.equal(m.problem_feeds.length, 4);
  assert.ok(formatMetrics(m).includes('Problem feeds'));
});

test('parseArgs', () => {
  assert.equal(parseArgs([]).hours, 24);
  assert.equal(parseArgs(['--hours', '72']).hours, 72);
  assert.throws(() => parseArgs(['--hours', '0']));
});
