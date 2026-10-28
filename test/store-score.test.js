import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFeed } from '../src/collect.js';
import { score, band, DEFAULT_CONFIG } from '../src/score.js';
import { openStore } from '../src/store.js';
import { makeIssue } from '../src/issue.js';

const NOW = Date.parse('2026-10-27T12:00:00Z');
const min = (m) => new Date(NOW - m * 60000).toISOString();
const A = { id: 'a', name: 'Источник А', url: 'x://a' };
const B = { id: 'b', name: 'Источник Б', url: 'x://b' };
const fx = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const loader = async (s) => parseFeed(await fx(s.id === 'a' ? 'a.rss.xml' : 'b.atom.xml'), s);

test('score: пример из методики = 90', () => {
  const times = [min(10), ...Array.from({ length: 12 }, (_, i) => min(10 - 0.5 * (i + 1)))];
  const r = score({ title: 'Землетрясение в стране Y, есть погибшие', firstSeen: min(10), independentSources: 2, times }, { now: NOW, audience: null });
  assert.equal(r.score, 90);
  assert.equal(r.reasons.length, 4 + 1); // 4 признака + пометка «острое»
  assert.equal(r.acute, true);
  assert.equal(r.needsOwner, true);
});

test('score: свежесть по ступеням', () => {
  const at = (m) => score({ title: 'x', firstSeen: min(m), independentSources: 3 }, { now: NOW }).score - 25;
  assert.deepEqual([10, 15, 16, 60, 61, 180, 181].map(at), [30, 30, 20, 20, 10, 10, 0]);
  assert.equal(score({ title: 'x', firstSeen: null, independentSources: 3 }, { now: NOW }).score, 25);
});

test('score: источники 1/2/3+, одно-источниковое — needsOwner', () => {
  const s = (n) => score({ title: 'x', firstSeen: min(500), independentSources: n }, { now: NOW });
  assert.deepEqual([0, 1, 2, 3, 7].map((n) => s(n).score), [0, 5, 15, 25, 25]);
  assert.equal(s(1).needsOwner, true);
  assert.equal(s(1).single, true);
  assert.equal(s(2).needsOwner, false);
  assert.match(s(1).reasons.join('|'), /одно-источниковое/);
});

test('score: тема и рост', () => {
  const t = (title) => score({ title, firstSeen: min(500), independentSources: 3 }, { now: NOW, audience: null });
  assert.equal(t('Трамп подписал указ о пошлинах').score, 25 + 15);
  assert.equal(t('Ракетный удар: есть погибшие').score, 25 + 25);
  assert.equal(t('Новые санкции против компании').score, 25 + 5);
  assert.equal(t('Открылась выставка кошек').score, 25);
  const g = (k) => score({ title: 'x', firstSeen: min(500), independentSources: 3, times: [min(500), ...Array.from({ length: k }, () => min(490))] }, { now: NOW }).score - 25;
  assert.deepEqual([0, 3, 4, 9, 10].map(g), [0, 0, 10, 10, 20]);
  // сообщения позже окна 30 мин не считаются
  assert.equal(score({ title: 'x', firstSeen: min(500), independentSources: 3, times: [min(500), min(400), min(300), min(200), min(100)] }, { now: NOW }).score, 25);
});

test('score: веса и пороги — из конфига, без правки кода', () => {
  const cfg = { ...DEFAULT_CONFIG, sources: { 1: 1, 2: 2, 3: 3 }, thresholds: { publish: 5, urgent: 6 } };
  assert.equal(score({ title: 'x', firstSeen: min(500), independentSources: 3 }, { now: NOW, config: cfg }).score, 3);
  assert.deepEqual([4, 5, 6].map((v) => band(v, cfg)), ['below', 'plan', 'urgent']);
  assert.deepEqual([39, 40, 69, 70].map((v) => band(v)), ['below', 'plan', 'plan', 'urgent']);
});

const ev = (over = {}) => ({
  id: 'e1', title: 'Событие', firstSeen: min(30), independentSources: 2, score: 55, reasons: ['r'], needsOwner: false,
  sources: [
    { source: 'a', name: 'А', link: 'https://a.example/1', published: min(30) },
    { source: 'b', name: 'Б', link: 'https://b.example/1', published: min(20) },
  ],
  ...over,
});

test('store: запись, чтение, статус', () => {
  const st = openStore(':memory:');
  const r = st.upsert(ev());
  assert.deepEqual(r, { id: 'e1', created: true, status: 'новое' });
  const got = st.get('e1');
  assert.equal(got.title, 'Событие');
  assert.equal(got.score, 55);
  assert.equal(got.independent_sources, 2);
  assert.equal(got.first_seen, min(30));
  assert.deepEqual(got.reasons, ['r']);
  assert.equal(got.sources.length, 2);
  assert.equal(got.sources[0].link, 'https://a.example/1');
  st.setStatus('e1', 'отклонено', 'тест');
  assert.equal(st.get('e1').status, 'отклонено');
  assert.equal(st.get('e1').status_reason, 'тест');
  assert.deepEqual(st.list({ status: 'отклонено' }).map((e) => e.id), ['e1']);
  assert.deepEqual(st.list({ status: 'новое' }), []);
  assert.throws(() => st.setStatus('e1', 'странный'), /неизвестный статус/);
  assert.throws(() => st.setStatus('нет', 'новое'), /нет события/);
  assert.equal(st.get('нет'), undefined);
  st.close();
});

test('store: повторная запись не плодит дубли, статус сохраняется', () => {
  const st = openStore(':memory:');
  st.upsert(ev());
  st.setStatus('e1', 'выпущено');
  const r = st.upsert(ev({ score: 60 }));
  assert.deepEqual(r, { id: 'e1', created: false, status: 'выпущено' });
  assert.equal(st.count(), 1);
  assert.equal(st.get('e1').sources.length, 2);
  assert.equal(st.get('e1').score, 60);
  assert.equal(st.get('e1').status, 'выпущено');
});

test('store: событие выросло и сменило id — это то же событие (по ссылкам)', () => {
  const st = openStore(':memory:');
  st.upsert(ev());
  const r = st.upsert(ev({
    id: 'другой-id', independentSources: 3, firstSeen: min(25),
    sources: [{ source: 'c', name: 'В', link: 'https://c.example/1', published: min(5) }, { source: 'a', name: 'А', link: 'https://a.example/1', published: min(30) }],
  }));
  assert.equal(r.id, 'e1');
  assert.equal(st.count(), 1);
  assert.equal(st.get('e1').sources.length, 3);
  assert.equal(st.get('e1').independent_sources, 3);
  assert.equal(st.get('e1').first_seen, min(30)); // раннее время не затирается
});

test('store: база живёт на диске между открытиями', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'news-db-'));
  try {
    const path = join(dir, 'sub', 'news.db');
    const s1 = openStore(path);
    s1.upsert(ev());
    s1.close();
    const s2 = openStore(path);
    assert.equal(s2.count(), 1);
    s2.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('выпуск: порог и одно-источниковое; причина в хранилище', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'news-'));
  try {
    // порог по умолчанию 40: что ниже — остаётся в базе как «отклонено» с причиной
    const { events } = await makeIssue({ outDir: dir, now: new Date(NOW), sources: [A, B], loader, dbPath: ':memory:' });
    assert.equal(events.length, 3);
    assert.ok(events.every((e) => typeof e.score === 'number'));
    assert.ok(events.some((e) => e.status === 'отклонено' && /ниже порога 40/.test(e.status_reason)));
    assert.ok(events.filter((e) => e.status !== 'выпущено').every((e) => e.status_reason));
    assert.ok(events.every((e) => e.status !== 'выпущено' || e.score >= 40));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('выпуск: повторный запуск не дублирует события и посты', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'news-'));
  const dbPath = join(dir, 'news.db');
  const low = { ...DEFAULT_CONFIG, thresholds: { publish: 0, urgent: 70 } };
  try {
    const run = (m) => makeIssue({ outDir: dir, now: new Date(NOW + m * 60000), sources: [A, B], loader, dbPath, scoreConfig: low });
    const r1 = await run(0);
    const md1 = await readFile(r1.path, 'utf8');
    assert.equal(md1.match(/^## /gm).length, 2); // два подтверждённых; одно-источниковое ждёт владельца
    const r2 = await run(1);
    const md2 = await readFile(r2.path, 'utf8');
    assert.doesNotMatch(md2, /^## /m);
    assert.match(md2, /Новостей нет/);
    const st = openStore(dbPath);
    assert.equal(st.count(), 3);
    assert.equal(st.list({ status: 'выпущено' }).length, 2);
    const waiting = st.list({ status: 'отобрано' });
    assert.equal(waiting.length, 1);
    assert.match(waiting[0].status_reason, /одобрения владельца/);
    assert.ok(waiting[0].sources.every((s) => s.link.startsWith('https://')));
    st.close();
    assert.ok(r2.events.every((e) => e.status === 'выпущено' || e.status === 'отобрано'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
