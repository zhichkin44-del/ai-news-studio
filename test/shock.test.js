import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { score, DEFAULT_CONFIG } from '../src/score.js';
import { DEFAULT_AUDIENCE } from '../src/audience.js';
import { openStore } from '../src/store.js';
import { topOfDay, selectEvents } from '../src/select-run.js';
import { digest, parseLocal } from '../src/digest.js';
import { highShare } from '../src/metrics.js';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const min = (m) => new Date(NOW - m * 60000).toISOString();
const ev = (title, o = {}) => ({ title, firstSeen: min(20), independentSources: 2, ru: true, ...o });
const sc = (e) => score(e, { now: NOW });
const GROUPS = new Set(['политика/война', 'мир и ЧП', 'наука', 'технологии и ИИ', 'экономика', 'культура/спорт/знаменитости']);

// --- 12 examples: 6 "wow" > 60, 6 routine < 40 ---
for (const title of [
  'Нобелевская премия по физике присуждена ученым за открытие',
  'Иран атаковал Ормузский пролив',
  'В Израиле изнасилована девочка',
  'У Anthropic закончились токены, модели остановились',
  'Землетрясение: сотни погибших',
  'Взлом банка: хакеры украли миллиард',
]) {
  test(`shock: «${title}» above 60`, () => {
    const r = sc(ev(title));
    assert.ok(r.score > 60, `score ${r.score}: ${r.reasons.join(' | ')}`);
  });
}
for (const title of [
  'Обзор смартфона Samsung Galaxy: стоит ли покупать',
  'Выборы в парламент Боливии: итоги голосования',
  'Скидки на ноутбуки: распродажа недели',
  'Корпоративный отчет: выручка выросла на 10 процентов',
  'Обычное заседание городского совета прошло спокойно',
  'Погода в Перми: небольшой снег',
]) {
  test(`routine: «${title}» below 40`, () => {
    const r = sc(ev(title, { ru: /[а-я]/i.test(title) }));
    assert.ok(r.score < 40, `score ${r.score}: ${r.reasons.join(' | ')}`);
  });
}

test('scale: score is at most 100 even with the maximum of triggers', () => {
  const r = sc(ev('Землетрясение: сотни погибших, тысячи жертв, обвал рынка, ядерная катастрофа', { independentSources: 5, category: 'accidents' }));
  assert.ok(r.score <= 100 && r.score >= 0, `score ${r.score}`);
});

test('shock profile: 9 classes with weights, rarity, group and ru+en triggers', () => {
  const file = JSON.parse(readFileSync(new URL('../src/audience.json', import.meta.url), 'utf8'));
  assert.equal(file.shock.classes.length, 9);
  const all = file.shock.classes.flatMap((c) => c.triggers).join(' ');
  for (const w of ['погиб', 'killed', 'изнасил', 'rape', 'землетряс', 'earthquake', 'ормуз', 'hormuz', 'нобелевск', 'nobel', 'anthropic', 'взлом', 'обвал', 'crash', 'рекорд', 'record', 'умер', 'death']) assert.ok(all.includes(w), w);
  for (const c of file.shock.classes) {
    assert.ok(c.weight > 0 && c.rarity >= 0 && c.rarity <= 1 && GROUPS.has(c.group), c.name);
  }
});

test('shock without confirmation is not awarded (one non-authoritative source)', () => {
  const lone = sc(ev('Нобелевская премия по физике присуждена ученым', { independentSources: 1 }));
  const two = sc(ev('Нобелевская премия по физике присуждена ученым'));
  assert.equal(lone.shock, 0);
  assert.ok(two.shock > 0);
  assert.ok(two.score > lone.score);
});

// --- top_of_day: ≤ 7, quotas by group, minimum outside politics ---
const T = (id, score, category, o = {}) => ({ id, score, first_seen: min(20), status: 'отобрано', category, ...o });

test('topOfDay: up to 7, no more than 2 from one group, rejected ones do not count', () => {
  const evs = [
    T('p1', 99, 'war'), T('p2', 98, 'war'), T('p3', 97, 'war'),
    T('s1', 90, 'science'), T('s2', 89, 'science'), T('s3', 88, 'science'),
    T('t1', 80, 'tech'), T('e1', 70, 'economy'), T('c1', 60, 'sport'), T('a1', 50, 'accidents'),
    T('rej', 100, 'war', { status: 'отклонено' }),
  ];
  const top = topOfDay(evs, { min: 40, perDay: 7, tzHours: 7 });
  assert.ok(top.size <= 7, `в топе ${top.size}`);
  const picked = evs.filter((e) => top.has(e.id));
  const by = (cat) => picked.filter((e) => e.category === cat).length;
  assert.ok(by('war') <= 2 && by('science') <= 2, 'quota 2 per group');
  assert.ok(!top.has('p3') && !top.has('s3'));
  assert.ok(picked.filter((e) => e.category !== 'war').length >= 3, 'minimum 3 outside politics');
  assert.ok(!top.has('rej'));
});

test('topOfDay: if everything is politics, still at most 2', () => {
  const top = topOfDay(Array.from({ length: 7 }, (_, i) => T(`p${i}`, 90 - i, 'war')), { min: 40, perDay: 7 });
  assert.equal(top.size, 2);
});

test('topOfDay: an event outside politics with score ≥ threshold displaces politics (minimum 3 of 7)', () => {
  const evs = [
    ...Array.from({ length: 7 }, (_, i) => T(`p${i}`, 90 - i, 'war')),
    T('out1', 45, 'science'), T('out2', 44, 'tech'), T('out3', 43, 'economy'),
  ];
  const top = topOfDay(evs, { min: 40, perDay: 7, perGroup: 7, minOutside: 3, politics: 'политика/война' });
  const picked = evs.filter((e) => top.has(e.id));
  assert.ok(picked.filter((e) => e.category !== 'war').length >= 3);
});

test('topOfDay: uses peak_score, not the current score', () => {
  const top = topOfDay([T('e', 30, 'science', { peak_score: 80 })], { min: 40, perDay: 7 });
  assert.ok(top.has('e'));
});

test('select: marks from past days are reset; only the current day is in the top', () => {
  const s = openStore(':memory:');
  const rec = (id, source, title, published) => ({ id, source, title, summary: '', link: `https://example.com/${id}`, published });
  s.addItems([rec('cur:1', 'a', 'Землетрясение магнитудой 7: есть погибшие', min(30))], { now: min(20) });
  const meta = { a: { lang: 'ru', category: 'accidents' } };
  s.upsert({ id: 'old', title: 'Старое событие', firstSeen: '2026-10-20T10:00:00Z', independentSources: 2, score: 90, reasons: [], needsOwner: false, sources: [{ source: 'b', link: 'https://example.com/old' }] }, '2026-10-20T10:00:00Z');
  s.setStatus('old', 'отобрано');
  s.setTopOfDay(new Set(['old']), ['old']);
  selectEvents(s, { hours: 3, now: new Date(NOW), sourceMeta: meta });
  assert.equal(s.get('old').top_of_day, 0);
  assert.ok(s.list().filter((e) => e.top_of_day === 1).length <= 7);
  s.close();
});

// --- peak_score in the store ---
test('peak_score: only goes up; the current score can drop', () => {
  const s = openStore(':memory:');
  const put = (v) => s.upsert({ id: 'e', title: 'Событие', firstSeen: min(30), independentSources: 2, score: v, reasons: [], needsOwner: false, sources: [{ source: 'a', link: 'https://x.test/1' }] });
  put(50);
  assert.equal(s.get('e').peak_score, 50);
  put(40);
  assert.deepEqual([s.get('e').score, s.get('e').peak_score], [40, 50]);
  put(70);
  put(30);
  assert.deepEqual([s.get('e').score, s.get('e').peak_score], [30, 70]);
  s.close();
});

test('digest: computes and returns the peak score', () => {
  const s = openStore(':memory:');
  const at = '2026-10-27T20:00:00Z';
  const put = (v) => s.upsert({ id: 'e', title: 'Ночное событие', firstSeen: at, independentSources: 2, score: v, reasons: [], needsOwner: false, sources: [{ source: 'a', link: 'https://x.test/1' }] }, at);
  put(60);
  put(30);
  s.setStatus('e', 'отобрано');
  s.setCategory('e', 'science');
  const d = digest(s, { from: new Date(parseLocal('2026-10-27T18:00')), to: new Date(parseLocal('2026-10-28T08:00')) });
  assert.equal(d.length, 1);
  assert.equal(d[0].score, 60);
  s.close();
});

// --- urgent: links accumulate in the database; counted per publisher ---
test('urgent: two links from one feed do not make 2 sources (no false «срочно»)', () => {
  const s = openStore(':memory:');
  const at = min(10);
  s.upsert({ id: 'one', title: 'Одно-источниковое событие', firstSeen: at, independentSources: 1, score: 90, reasons: [], needsOwner: false, sources: [
    { source: 'a1', link: 'https://a.test/1', published: at }, { source: 'a2', link: 'https://a.test/2', published: at },
  ] }, at);
  s.setStatus('one', 'отобрано');
  s.upsert({ id: 'two', title: 'Подтверждённое событие', firstSeen: at, independentSources: 2, score: 90, reasons: [], needsOwner: false, sources: [
    { source: 'b1', link: 'https://b.test/1', published: at }, { source: 'b2', link: 'https://b.test/2', published: at },
  ] }, at);
  s.setStatus('two', 'отобрано');
  s.addItems([{ id: 'z:1', source: 'z', title: 'Открылся музей кошек', summary: '', link: 'https://z.test/1', published: at }], { now: at });
  selectEvents(s, {
    hours: 3, now: new Date(NOW),
    groups: { a1: 'a', a2: 'a', b1: 'b1', b2: 'b2', z: 'z' },
    sourceMeta: { z: { lang: 'ru', category: 'society' } },
  });
  assert.equal(s.get('one').breaking, 0, 'one feed (2 links) — not urgent');
  assert.equal(s.get('two').breaking, 1, 'two publishers — urgent');
  s.close();
});

test('section: news from a common ru feed (russia) with the topic «экономика» (economy) is not politics', () => {
  const s = openStore(':memory:');
  const at = min(10);
  s.addItems([{ id: 'r:1', source: 'r', title: 'Курс доллара вырос на торгах', summary: '', link: 'https://r.test/1', published: at }], { now: at });
  selectEvents(s, { hours: 3, now: new Date(NOW), sourceMeta: { r: { lang: 'ru', category: 'russia' } } });
  assert.equal(s.list()[0].section, 'экономика');
  s.close();
});

test('aging: an event with a high peak does not go to «отклонено» and stays in the top', () => {
  const s = openStore(':memory:');
  const at = min(30);
  s.upsert({ id: 'e', title: 'Сильное событие', firstSeen: at, independentSources: 2, score: 70, reasons: [], needsOwner: false, sources: [{ source: 'a', link: 'https://e.test/1', published: at }] }, at);
  s.setStatus('e', 'отобрано');
  s.addItems([
    { id: 'a:2', source: 'a', title: 'Погода в Перми: небольшой снег', summary: '', link: 'https://e.test/1', published: min(20) },
    { id: 'b:2', source: 'b', title: 'Погода в Перми: небольшой снег', summary: '', link: 'https://e.test/1', published: min(20) },
  ], { now: min(20) });
  selectEvents(s, { hours: 3, now: new Date(NOW), sourceMeta: { a: { lang: 'ru', category: 'society' }, b: { lang: 'ru', category: 'society' } } });
  const e = s.get('e');
  assert.notEqual(e.status, 'отклонено');
  assert.equal(e.peak_score, 70);
  assert.equal(e.top_of_day, 1);
  s.close();
});

test('metric of the share of high scores: ≥ 60 out of all events', () => {
  assert.equal(highShare([30, 60, 70, 40]), 0.5);
  assert.equal(highShare([], 60), null);
  assert.equal(highShare([59, 60], 60), 0.5);
});

test('select: «отобрано» is no more than the daily ceiling', () => {
  const s = openStore(':memory:');
  const titles = ['Землетрясение в Японии', 'Открылся музей кошек', 'Футбольный матч перенесли'];
  const rec = (i) => ({ id: `a:${i}`, source: 'a', title: titles[i - 1], summary: '', link: `https://example.com/${i}`, published: min(20 + i) });
  s.addItems([rec(1), rec(2), rec(3)], { now: min(10) });
  const cfg = { ...DEFAULT_CONFIG, thresholds: { publish: 0, urgent: 70 }, daily_selected_max: 2 };
  const r = selectEvents(s, { hours: 3, now: new Date(NOW), scoreConfig: cfg });
  assert.equal(s.list().filter((e) => e.status === 'отобрано').length, 2);
  assert.equal(r.selected, 2);
  assert.ok(s.list().some((e) => /дневной лимит 2/.test(e.status_reason ?? '')));
  s.close();
});
