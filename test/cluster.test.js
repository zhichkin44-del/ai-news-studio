import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cluster, anchors, skeleton, langOf, keys, weightedSimilarity } from '../src/cluster.js';

let n = 0;
const it = (source, title, published = '2026-10-28T08:00:00Z', extra = {}) => ({ id: `${source}:${++n}`, source, title, summary: '', link: `https://${source}.example/${n}`, published, ...extra });
const GROUPS = { 'bbc-world': 'bbc', 'bbc-russian': 'bbc' };

const PAIRS = [
  ['Испания — поезда',
    'At least 30 dead and 80 injured after two trains collide in Spain – latest updates',
    'В Испании столкнулись два поезда: погибли не менее 30 человек'],
  ['Газа — зима',
    'Families brace for a fourth winter of wind, rain and floods in Gaza’s camps',
    'Семьи в лагерях Газы готовятся к четвёртой зиме: ветер, дожди и наводнения'],
  ['Израиль — явка',
    'High voter turnout among Palestinian citizens of Israel threatens Netanyahu',
    'Высокая явка арабских избирателей в Израиле создаёт угрозу для Нетаньяху'],
];

for (const [name, en, ru] of PAIRS) {
  test(`en/ru об одном событии склеиваются: ${name}`, () => {
    const cl = cluster([it('aljazeera', en), it('dw-ru', ru, '2026-10-28T10:00:00Z')], 0.4, GROUPS);
    assert.equal(cl.length, 1);
    assert.equal(cl[0].sourceCount, 2);
    assert.equal(cl[0].status, 'подтверждено');
  });
}

test('разные события с общей страной не склеиваются', () => {
  const items = [
    it('aljazeera', 'Israeli strike kills 12 in Gaza City'),
    it('dw-ru', 'Семьи в лагерях Газы готовятся к четвёртой зиме'),
    it('guardian-world', 'Spain budget: government loses key parliamentary vote'),
    it('dw-ru', 'В Испании столкнулись два поезда: погибли не менее 30 человек'),
    it('npr-world', 'Israeli forces continue West Bank raids as Hebron lockdown enters sixth day'),
    it('un-ru', 'Высокая явка на выборах в Израиле'),
  ];
  assert.equal(cluster(items, 0.4, GROUPS).length, 6);
});

test('окно 12 часов: то же событие через сутки — разные кластеры', () => {
  const [en, ru] = PAIRS[0].slice(1);
  assert.equal(cluster([it('aljazeera', en, '2026-10-27T06:00:00Z'), it('dw-ru', ru, '2026-10-28T08:00:00Z')]).length, 2);
  assert.equal(cluster([it('aljazeera', en, '2026-10-28T00:00:00Z'), it('dw-ru', ru, '2026-10-28T11:30:00Z')]).length, 1);
});

test('BBC World и BBC Русская служба — одно агентство', () => {
  const [en, ru] = PAIRS[0].slice(1);
  const cl = cluster([it('bbc-world', en), it('bbc-russian', ru)], 0.4, GROUPS);
  assert.ok(cl.every((c) => c.sourceCount === 1 && c.status === 'не подтверждено')); // два BBC — не подтверждение
  const withDw = cluster([it('bbc-world', en), it('bbc-russian', ru), it('dw-ru', 'Столкновение поездов в Испании: десятки погибших')], 0.4, GROUPS);
  assert.equal(withDw.length, 1);
  assert.equal(withDw[0].sourceCount, 2);
});

test('внутри языка: пересказы склеиваются, повторный заход не плодит дубли', () => {
  const a = it('aljazeera', 'Two trains collide in Spain, dozens killed');
  const b = it('guardian-world', 'Spain train crash: dozens killed after two trains collide');
  const again = { ...a, id: 'aljazeera:again' }; // та же ссылка при повторном заходе
  const cl = cluster([a, b, again], 0.4, GROUPS);
  assert.equal(cl.length, 1);
  assert.equal(cl[0].sourceCount, 2);
  assert.equal(cl[0].items.length, 3);
});

test('составной заголовок NPR «А. And, Б» не тянет тему Б', () => {
  const items = [
    it('npr-world', "Israel's election too close to call. And, the Ebola outbreak reaches grim milestone"),
    it('npr-world', 'The Ebola outbreak is breaking records -- and just marked a grim milestone'),
  ];
  assert.equal(cluster(items).length, 2);
});

test('якоря: словарь ru↔en, числа, имена по скелету', () => {
  const en = anchors('Two trains collide in Spain, 30 dead, Rodriguez says');
  const ru = anchors('В Испании столкнулись поезда, 30 погибших, заявил Родригес');
  for (const k of ['spain', 'train', 'crash', '#30']) assert.ok(en.has(k) && ru.has(k), k);
  assert.equal(en.get('spain'), 'geo');
  assert.equal(skeleton('Нетаньяху'), skeleton('Netanyahu'));
  assert.ok(!anchors('Tell us what you think').has('usa'), '«us» в нижнем регистре — не США');
  assert.ok(!anchors('Выпущен в 2026 году').has('#2026'), 'годы — не якорь');
});

test('ключи: числа и имена весят больше, окончания ru срезаются', () => {
  const k = keys('Россия назвала 30 погибших в Гамбурге');
  assert.equal(k.get('30'), 2);
  assert.equal(k.get('гамбур'), 2);
  assert.ok(weightedSimilarity(keys('Выборы в Бразилии прошли'), keys('Выборы в Бразилии')) > 0.4);
  assert.equal(weightedSimilarity(new Map(), keys('x1y')), 0);
  assert.equal(langOf('Выборы в Бразилии'), 'ru');
  assert.equal(langOf('Elections in Brazil'), 'en');
});

test('индекс кандидатов даёт те же кластеры, что полный перебор пар; кэш по id не путает записи', () => {
  let seed = 11;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const vocab = Array.from({ length: 40 }, (_, i) => `слово${'абвгдежз'[i % 8]}${'ийклмноп'[Math.floor(i / 8)]}ка`);
  const items = Array.from({ length: 300 }, (_, i) => ({
    id: i + 1, source: `s${i % 7}`, link: `l${i}`, summary: '', published: '2026-10-28T10:00:00Z',
    title: Array.from({ length: 4 + Math.floor(rnd() * 3) }, () => vocab[Math.floor(rnd() ** 2 * vocab.length)]).join(' '),
  }));
  const ks = items.map((i) => keys(i.title));
  const parent = items.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) if (weightedSimilarity(ks[i], ks[j]) >= 0.4) parent[find(j)] = find(i);
  const expected = new Map();
  items.forEach((it, i) => { const r = find(i); expected.set(r, [...(expected.get(r) ?? []), it.id]); });
  const sig = (groups) => groups.map((g) => [...g].sort((a, b) => a - b).join(',')).sort().join('|');
  const got = cluster(items).map((c) => c.items.map((i) => i.id));
  assert.equal(sig(got), sig([...expected.values()]));
  assert.equal(sig(cluster(items).map((c) => c.items.map((i) => i.id))), sig(got)); // повторный проход с тёплым кэшем
  // тот же id с другим заголовком — разбор пересчитывается
  const a = { id: 9001, source: 'x', link: 'a1', summary: '', published: '2026-10-28T10:00:00Z', title: 'совсем другое про лес' };
  const b = { id: 9002, source: 'y', link: 'a2', summary: '', published: '2026-10-28T10:00:00Z', title: 'совсем другое про лес' };
  assert.equal(cluster([a, b]).length, 1);
  assert.equal(cluster([a, { ...b, title: 'иная тема про море зимой' }]).length, 2);
  assert.equal(cluster([{ ...a, title: 'иная тема про море зимой' }, { ...b, title: 'иная тема про море зимой' }]).length, 1);
});
