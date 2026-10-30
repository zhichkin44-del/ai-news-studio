import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { score } from '../src/score.js';
import { audienceScore, shockScore } from '../src/audience.js';
import { topOfDay } from '../src/select-run.js';
import { pickDiverse, sameStory,sectionFor, POLITICS, WORLD_EMERGENCY, SCIENCE } from '../src/diversity.js';

const json = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const aud = json('../src/audience.json');
const cfg = json('../src/score.config.json');
const NOW = Date.parse('2026-10-28T12:00:00Z');
const first = new Date(NOW - 20 * 60000).toISOString();
const sc = (title, o = {}) => score({ title, firstSeen: first, independentSources: 2, ru: true, ...o }, { now: NOW });
const topic = (n) => aud.topics.find((t) => t.name === n);
const T = (id, score, category, o = {}) => ({ id, score, first_seen: first, status: 'отобрано', category, ...o });

test('правка 1: веса категорий — наука/техника/мир подняты, война сжата', () => {
  assert.deepEqual(aud.category_weights, { war: 5, russia: 5, economy: 6, accidents: 6, science: 6, tech: 6, world: 4, society: 3, celebrity: 3, sport: 3 });
});

test('правка 2: наука-сенсации вес 22 (общая «вау» остаётся 6), Нобелевка получает ru_bonus', () => {
  assert.equal(topic('Наука: «вау»').weight, 6);
  const t = topic('Наука: премии и сенсации');
  assert.equal(t.weight, 22);
  for (const w of ['нобелевск', 'nobel', 'сверхпровод', 'термоядерн', 'клонир']) assert.ok(t.triggers.includes(w), w);
  const a = audienceScore({ title: 'Нобелевская премия по химии вручена', ru: true }, aud);
  assert.ok(a.reasons.some((r) => r.includes('русскоязычный')), a.reasons.join('|'));
});

test('правка 3: тема «Технологии, ИИ и глобальные сбои» ловит сбой Claude', () => {
  const t = topic('Технологии, ИИ и глобальные сбои');
  assert.equal(t.category, 'tech');
  assert.equal(t.weight, 22);
  assert.equal(audienceScore({ title: 'Массовый сбой в ChatGPT: сервис перестал работать' }, aud).topic, t.name);
});

test('правка 4: шок-криминал — тема accidents, вес 23', () => {
  const t = topic('Шок-криминал и резонансные преступления');
  assert.equal(t.category, 'accidents');
  assert.equal(t.weight, 23);
  assert.equal(audienceScore({ title: 'В Томске поймали маньяка' }, aud).topic, t.name);
});

test('правка 5: мировые узлы (Ормуз, танкеры) — вес 20 и триггеры', () => {
  const t = topic('Крупные мировые события');
  assert.equal(t.weight, 20);
  for (const w of ['ормуз', 'танкер', 'хусит', 'тайван']) assert.ok(t.triggers.includes(w), w);
  assert.equal(audienceScore({ title: 'Хуситы атаковали танкер' }, aud).topic !== null, true);
});

test('правка 6: вес «Война и Украина» снижен до 24', () => {
  assert.equal(topic('Война и Украина').weight, 24);
});

test('правка 7: пустая дипломатия штрафуется, с решением — нет', () => {
  const empty = audienceScore({ title: 'Лавров и Рубио обсудили вопрос Украины' }, aud);
  assert.ok(empty.reasons.some((r) => r.includes('пустая дипломатия')), empty.reasons.join('|'));
  const real = audienceScore({ title: 'Путин подписал закон о выплатах, министры обсудили вопрос' }, aud);
  assert.ok(!real.reasons.some((r) => r.includes('пустая дипломатия')));
});

test('антирейтинг: «погиб пресс-офицер», брифинг, «обсудили позицию» — минус', () => {
  for (const title of ['Погиб пресс-офицер бригады на Донбассе', 'Брифинг Минобороны: обстрел отражен', 'Трамп и Эрдоган обсудили позицию по Украине']) {
    const a = audienceScore({ title }, aud);
    assert.ok(a.reasons.some((r) => r.includes('однотипные сводки')), `${title}: ${a.reasons.join('|')}`);
  }
  const big = audienceScore({ title: 'Брифинг: погибли сотни человек' }, aud);
  assert.ok(!big.reasons.some((r) => r.includes('однотипные сводки')));
  // однотипный военный заголовок оценивается ниже порога публикации
  assert.ok(sc('Погиб пресс-офицер бригады на Донбассе').score < 60);
});

test('однотипная сводка не получает шок за слово «погиб»', () => {
  const r = sc('Погиб пресс-офицер бригады на Донбассе');
  assert.ok(r.reasons.some((x) => x.includes('шок отменён')), r.reasons.join('|'));
  assert.ok(sc('Погибли сотни человек при землетрясении').reasons.every((x) => !x.includes('шок отменён')));
});

test('слабая тема (вес ниже ru_bonus_min_weight) не получает категорийный вес', () => {
  const a = audienceScore({ title: 'Breakthrough battery lasts a million cycles' }, aud);
  assert.ok(!a.reasons.some((x) => x.includes('категория')), a.reasons.join('|'));
});

test('правка 8: score.config.topics синхронизированы', () => {
  assert.ok(cfg.topics['Наука и технологии «ничего себе»'].includes('нобелевск'));
  assert.ok(cfg.topics['Войны и конфликты'].includes('ормуз'));
  assert.ok(cfg.topics['Громкие происшествия'].includes('изнасилов'));
});

test('шок-профиль: сбои ИИ, цены/курсы, аномалии, пути, преступления', () => {
  const g = (title) => shockScore({ title, independentSources: 2 }, aud);
  assert.equal(g('Claude перестал работать у тысяч пользователей').group, 'технологии и ИИ');
  assert.equal(g('Курс доллара взлетел до рекорда').group, 'экономика');
  assert.equal(g('Учёные нашли загадочную аномалию на Луне').group, 'мир и ЧП');
  assert.equal(g('Хуситы атаковали танкер у Суэца').group, 'политика/война');
  assert.equal(g('Мужчина зарезал соседа в Туле').group, 'мир и ЧП');
});

test('правка 9: квота жёсткая — политики не больше трети (2 из 7), войной не добиваем', () => {
  const evs = Array.from({ length: 9 }, (_, i) => T(`p${i}`, 95 - i, 'war'));
  const top = topOfDay(evs, { min: 40, perDay: 7, perGroup: 7, minOutside: 4, politics: POLITICS });
  assert.equal(top.size, 2);
});

test('правка 9: пониженный порог — вне политики берём события ниже 40, но не ниже 40-relax', () => {
  const evs = [
    ...Array.from({ length: 5 }, (_, i) => T(`p${i}`, 90 - i, 'war')),
    T('s', 36, 'science'), T('t', 33, 'tech'), T('e', 31, 'economy'), T('c', 35, 'sport'), T('low', 25, 'accidents'),
  ];
  const strictOnly = topOfDay(evs, { min: 40, perDay: 7, perGroup: 7, minOutside: 4, politics: POLITICS });
  assert.equal(strictOnly.size, 2, 'без relax вне политики ничего нет — только 2 политики (треть)');
  const top = topOfDay(evs, { min: 40, perDay: 7, perGroup: 7, minOutside: 4, politics: POLITICS, relax: 10 });
  const picked = evs.filter((e) => top.has(e.id));
  assert.equal(picked.filter((e) => e.category === 'war').length, 2);
  assert.deepEqual(picked.filter((e) => e.category !== 'war').map((e) => e.id).sort(), ['c', 'e', 's', 't']);
  assert.ok(!top.has('low'));
});

test('правка 9: сильные внеполитические события вытесняют войну (5 войн из 7 больше невозможно)', () => {
  const evs = [
    ...['a', 'b', 'c', 'd', 'e'].map((x, i) => T(x, 99 - i, 'war')),
    T('s1', 70, 'science'), T('t1', 65, 'tech'), T('e1', 60, 'economy'), T('c1', 55, 'celebrity'),
  ];
  const top = topOfDay(evs, { min: 40, perDay: 7, minOutside: 4, politics: POLITICS, relax: 10 });
  assert.equal(evs.filter((e) => top.has(e.id) && e.category === 'war').length, 2);
  assert.equal(top.size, 6);
});

test('pickDiverse: два события об одном (общая сущность + число) — берётся одно, место отдаётся другому', () => {
  const ev = (id, score, title, category = 'accidents') => ({ id, title, category, score, peak_score: score, first_seen: '2026-10-29T01:00:00Z' });
  const evs = [
    ev('a', 90, 'Землетрясение магнитудой 7 в Японии: 12 погибших'),
    ev('b', 85, 'В Японии произошло землетрясение, число жертв выросло до 12'),
    ev('c', 60, 'Ураган накрыл Флориду', 'accidents'),
    ev('d', 55, 'Новый чип удвоил скорость вычислений', 'tech'),
  ];
  const ids = pickDiverse(evs, { limit: 7, perGroup: 7, minOutside: 0, strict: true }).map((e) => e.id);
  assert.deepEqual(ids, ['a', 'c', 'd']);
  assert.equal(sameStory(evs[0], evs[2]), false);
});

test('pickDiverse: политика/война не больше трети (2 из 7) в strict', () => {
  const evs = [
    ...['a', 'b', 'c', 'd', 'e'].map((x, i) => T(x, 99 - i, 'war')),
    T('s1', 70, 'science'), T('t1', 65, 'tech'), T('e1', 60, 'economy'), T('c1', 55, 'celebrity'),
  ];
  const got = pickDiverse(evs, { limit: 7, perGroup: 7, minOutside: 2, strict: true });
  assert.equal(got.filter((e) => e.category === 'war').length, 2);
});

test('pickDiverse без strict сохраняет прежнее поведение (срочное)', () => {
  const evs = Array.from({ length: 7 }, (_, i) => T(`p${i}`, 90 - i, 'war'));
  assert.equal(pickDiverse(evs, { limit: 7, perGroup: 7, minOutside: 4 }).length, 7);
});

test('группа: «погибшие в Херсоне» (шок «мир и ЧП» + тема война) → политика/война', () => {
  assert.equal(sectionFor({ shockGroup: WORLD_EMERGENCY, audienceCategory: 'war', feedCategory: 'world' }), POLITICS);
  assert.equal(sectionFor({ shockGroup: SCIENCE, audienceCategory: 'war' }), SCIENCE);
  assert.equal(sectionFor({ shockGroup: null, audienceCategory: 'accidents' }), WORLD_EMERGENCY);
});

test('правка 10 (источники): не делалась — здесь только проверка, что конфиг валиден', () => {
  assert.equal(cfg.diversity.min_outside_politics, 4);
  assert.equal(cfg.diversity.relax_points, 10);
});
