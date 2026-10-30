import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { topOfDay } from '../src/select-run.js';
import { POLITICS, CATEGORY_SECTION } from '../src/diversity.js';

const cfg = JSON.parse(readFileSync(new URL('../src/score.config.json', import.meta.url), 'utf8'));
const ceilings = cfg.diversity.ceilings;
const first = '2026-10-28T05:00:00Z';
const E = (id, score, category, title = id) => ({ id, title, score, first_seen: first, status: 'отобрано', category, section: CATEGORY_SECTION[category] });
const run = (evs) => {
  const top = topOfDay(evs, { min: 40, perDay: 7, perGroup: 2, minOutside: 4, politics: POLITICS, relax: 10, ceilings });
  return evs.filter((e) => top.has(e.id)).map((e) => e.id);
};

test('потолки лежат в конфиге', () => {
  assert.equal(ceilings.sport, 1);
  assert.equal(ceilings.showbiz, 1);
  assert.equal(ceilings.topic, 2);
  assert.equal(ceilings.politics, 3);
});

test('спорт: без сенсации в топ не идёт, сенсация — не больше одного', () => {
  const evs = [
    E('s1', 95, 'sport', 'Клуб выиграл матч 2:1'), E('s2', 94, 'sport', 'Тренер уволен'),
    E('r1', 80, 'sport', 'Мировой рекорд в беге'), E('r2', 79, 'sport', 'Допинг-скандал на турнире'),
    E('sc', 60, 'science'),
  ];
  assert.deepEqual(run(evs).sort(), ['r1', 'sc']);
});

test('спорт: сверхсумма трансфера и финал считаются сенсацией', () => {
  assert.deepEqual(run([E('t', 90, 'sport', 'Трансфер за 150 млн евро')]), ['t']);
  assert.deepEqual(run([E('f', 90, 'sport', 'Финал чемпионата мира')]), ['f']);
  assert.deepEqual(run([E('x', 90, 'sport', 'Контракт продлён на три года')]), []);
});

test('шоу-бизнес: не больше одного', () => {
  const evs = [E('c1', 90, 'celebrity'), E('c2', 85, 'celebrity'), E('c3', 80, 'celebrity')];
  assert.deepEqual(run(evs), ['c1']);
});

test('тема: не больше двух; политика — не больше трети (2 из 7)', () => {
  const evs = [
    ...['a', 'b', 'c', 'd', 'e'].map((x, i) => E(x, 99 - i, 'war')),
    ...['t1', 't2', 't3', 't4'].map((x, i) => E(x, 70 - i, 'tech')),
  ];
  const ids = run(evs);
  assert.equal(ids.filter((i) => 'abcde'.includes(i)).length, 2);
  assert.equal(ids.filter((i) => i.startsWith('t')).length, 2);
});

test('нехватка сильных вне потолков: места остаются пустыми', () => {
  const evs = [
    E('s1', 90, 'sport', 'Мировой рекорд'), E('s2', 89, 'sport', 'Финал турнира'),
    E('c1', 88, 'celebrity'), E('c2', 87, 'celebrity'),
    E('p1', 86, 'war'), E('p2', 85, 'war'), E('p3', 84, 'war'), E('p4', 83, 'war'),
  ];
  assert.deepEqual(run(evs).sort(), ['c1', 'p1', 'p2', 's1']);
});

test('без ceilings прежнее поведение: perGroup=2 для спорта', () => {
  const evs = [E('s1', 95, 'sport'), E('s2', 94, 'sport'), E('s3', 93, 'sport')];
  const top = topOfDay(evs, { min: 40, perDay: 7, perGroup: 2, minOutside: 0, politics: POLITICS });
  assert.equal(top.size, 2);
});
