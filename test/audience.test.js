import { test } from 'node:test';
import assert from 'node:assert/strict';
import { score, isBreaking } from '../src/score.js';
import { audienceScore, DEFAULT_AUDIENCE } from '../src/audience.js';
import { openStore } from '../src/store.js';
import { selectEvents } from '../src/select-run.js';
import { digest, lastNight, parseLocal } from '../src/digest.js';
import { readFileSync } from 'node:fs';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const min = (m) => new Date(NOW - m * 60000).toISOString();
const ev = (title, o = {}) => ({ title, firstSeen: min(20), independentSources: 1, ru: true, ...o });
const sc = (e) => score(e, { now: NOW });

// --- 8 примеров: 4 высоко (>60), 4 низко (<40) ---
for (const [title, o] of [
  ['Россия нанесла удар по Киеву, есть погибшие', { independentSources: 2 }],
  ['Путин заявил о готовности к переговорам по Украине', { independentSources: 2 }],
  ['Рубль упал до минимума с весны, ЦБ повысил курс доллара', { independentSources: 2 }],
  ['Трамп пригрозил России новыми санкциями', { independentSources: 2 }],
]) {
  test(`аудитория: «${title}» выше 60`, () => {
    const r = sc(ev(title, o));
    assert.ok(r.score > 60, `score ${r.score}: ${r.reasons.join(' | ')}`);
  });
}
for (const title of [
  'Выборы в Колумбии: кандидаты подвели итоги кампании',
  'Обзор смартфона Samsung Galaxy: стоит ли покупать',
  'Скидка 50% на ноутбуки: лучшие deals недели',
  'Review: new budget headphones tested',
]) {
  test(`аудитория: «${title}» ниже 40`, () => {
    const r = sc(ev(title, { ru: /[а-я]/i.test(title) }));
    assert.ok(r.score < 40, `score ${r.score}: ${r.reasons.join(' | ')}`);
  });
}

test('порядок: удар по Киеву > выборы в Колумбии на равных условиях', () => {
  const hi = sc(ev('Удар по Киеву', { independentSources: 2 }));
  const lo = sc(ev('Выборы в Колумбии', { independentSources: 2 }));
  assert.ok(hi.score > lo.score + 40);
});

// --- профиль ---
test('профиль: темы с весами и триггерами ru+en, штрафы; читается из audience.json', () => {
  const file = JSON.parse(readFileSync(new URL('../src/audience.json', import.meta.url), 'utf8'));
  assert.deepEqual(file.topics.map((t) => t.name), DEFAULT_AUDIENCE.topics.map((t) => t.name));
  for (const t of file.topics) assert.ok(t.weight > 0 && t.triggers.length && t.category, t.name);
  const all = file.topics.flatMap((t) => t.triggers).join(' ');
  for (const w of ['путин', 'putin', 'кремл', 'украин', 'ukrain', 'киев', 'kyiv', 'обстрел', 'ракет', 'дрон', 'фронт', 'мобилизац', 'санкци', 'рубл', 'бензин', 'налог', 'пенси', 'трамп', 'trump', 'зеленск', 'теракт', 'взрыв', 'пожар', 'погиб', 'арест', 'скандал']) assert.ok(all.includes(w), w);
  assert.ok(file.penalties.length >= 2);
});

test('профиль: сильнейшая тема, русскоязычный бонус, штраф вычитается', () => {
  const p = (title, ru) => audienceScore({ title, ru });
  assert.equal(p('Обстрел Харькова', true).topic, 'Война и Украина');
  assert.equal(p('Обстрел Харькова', true).category, 'war');
  assert.equal(p('Shelling of Kharkiv, Ukraine says', false).topic, 'Война и Украина');
  assert.equal(p('Обстрел Харькова', true).points - p('Обстрел Харькова', false).points, DEFAULT_AUDIENCE.ru_bonus);
  assert.equal(p('Открылась выставка кошек', true).points, 0);
  assert.ok(p('Погода в Перми', true).points < 0, 'рутинная погода штрафуется');
  assert.ok(p('Выборы в Боливии', true).points < 0);
  assert.equal(p('Выборы в Госдуму: Путин проголосовал', true).points > 0, true, 'выборы в России/с Путиным не штрафуются');
});

test('профиль правится без кода: свой профиль меняет оценку', () => {
  const custom = { ...DEFAULT_AUDIENCE, topics: [{ name: 'Погода', category: 'society', weight: 40, triggers: ['погод'] }], penalties: [] };
  const e = ev('Погода в Перми: снег');
  assert.equal(score(e, { now: NOW, audience: custom }).score - score(e, { now: NOW, audience: null }).score, 40 + 2 + 8);
});

// --- breaking ---
test('breaking: оценка ≥ 70 и 2+ источника за последние 60 минут', () => {
  const two = [{ published: min(10) }, { published: min(40) }];
  assert.equal(isBreaking(75, two, { now: NOW }), true);
  assert.equal(isBreaking(69, two, { now: NOW }), false, 'оценка ниже');
  assert.equal(isBreaking(90, [{ published: min(10) }], { now: NOW }), false, 'один источник');
  assert.equal(isBreaking(90, [{ published: min(10) }, { published: min(90) }], { now: NOW }), false, 'второй старше 60 минут');
});

const feed = (id, source, title, minutesAgo, i = 0) => ({ id: `${source}:${id}${i}`, source, title, summary: '', link: `https://x.test/${source}/${id}`, published: min(minutesAgo) });
const addItems = (store, items) => store.addItems(items, { now: min(0) });

test('select: breaking=1 у подтверждённого свежего удара, у выборов и одиночных — 0', () => {
  const store = openStore(':memory:');
  addItems(store, [
    feed('a', 'tass', 'Российские ракеты ударили по Киеву, погибли люди', 15),
    feed('b', 'ria', 'Российские ракеты ударили по Киеву, погибли люди и раненые', 12),
    feed('c', 'lenta', 'Выборы в Колумбии: кандидаты подвели итоги кампании', 10),
    feed('d', 'meduza', 'Путин заявил, что переговоров не будет', 5),
  ]);
  const meta = { tass: { lang: 'ru', category: 'russia' }, ria: { lang: 'ru', category: 'russia' }, lenta: { lang: 'ru', category: 'russia' }, meduza: { lang: 'ru', category: 'society' } };
  const r = selectEvents(store, { hours: 3, now: new Date(NOW), sourceMeta: meta });
  const by = (re) => store.list().find((e) => re.test(e.title));
  assert.equal(r.breaking, 1);
  assert.equal(by(/Киев/).breaking, 1);
  assert.equal(by(/Колумб/).breaking, 0);
  assert.equal(by(/Путин/).breaking, 0);
  assert.equal(by(/Киев/).category, 'war');
  assert.ok(by(/Киев/).score >= 70);
  // повторный прогон идемпотентен
  selectEvents(store, { hours: 3, now: new Date(NOW), sourceMeta: meta });
  assert.equal(store.list().filter((e) => e.breaking).length, 1);
  store.close();
});

// --- digest ---
test('digest: ночь 18:00→08:00 по UTC+7, до 7 лучших, поля id/title/score/category', () => {
  const store = openStore(':memory:');
  const put = (id, title, score, firstSeen, status = 'отобрано', category = 'accidents') => {
    store.upsert({ id, title, firstSeen, independentSources: 2, score, reasons: [], needsOwner: false, sources: [{ source: 's', link: `https://x.test/${id}` }] }, firstSeen);
    store.setStatus(id, status);
    store.setCategory(id, category);
  };
  // ночь 27→28 окт по UTC+7 = 27.10 11:00Z … 28.10 01:00Z; категории разные — квота 2 на группу
  const cats = ['war', 'science', 'tech', 'economy'];
  for (let i = 0; i < 9; i++) put(`n${i}`, `ночное ${i}`, 50 + i, `2026-10-27T${String(12 + i).padStart(2, '0')}:00:00Z`, 'отобрано', cats[i % cats.length]);
  put('day', 'дневное', 99, '2026-10-27T05:00:00Z'); // 12:00 по UTC+7 — вне окна
  put('late', 'после 08:00', 99, '2026-10-28T01:00:00Z'); // ровно 08:00 — вне окна
  put('rej', 'отклонённое', 98, '2026-10-27T15:00:00Z', 'отклонено');
  const from = new Date(parseLocal('2026-10-27T18:00'));
  const to = new Date(parseLocal('2026-10-28T08:00'));
  assert.equal(from.toISOString(), '2026-10-27T11:00:00.000Z');
  const d = digest(store, { from, to });
  assert.equal(d.length, 7);
  assert.deepEqual(Object.keys(d[0]), ['id', 'title', 'score', 'category']);
  assert.deepEqual(d.map((e) => e.score), [58, 57, 56, 55, 54, 53, 52]);
  assert.ok(!d.some((e) => ['day', 'late', 'rej'].includes(e.id)));
  store.close();
});

test('digest: окно по умолчанию — последняя законченная ночь', () => {
  const a = lastNight(new Date('2026-10-28T05:00:00Z')); // 12:00 по UTC+7 → ночь 27→28
  assert.equal(a.to.toISOString(), '2026-10-28T01:00:00.000Z');
  assert.equal(a.from.toISOString(), '2026-10-27T11:00:00.000Z');
  const b = lastNight(new Date('2026-10-27T23:00:00Z')); // 06:00 28.10 → ещё идёт, берём прошлую
  assert.equal(b.to.toISOString(), '2026-10-27T01:00:00.000Z');
});
