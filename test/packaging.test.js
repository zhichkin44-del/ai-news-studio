import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { sanitizeHtml, visibleText, cardText, escapeText } from '../src/markup.js';
import { gate } from '../src/gate.js';
import { ingestPosts } from '../src/ingest.js';
import { formatPost, publish } from '../src/publish.js';
import { runDaily, buildDigest, leadOf, boldLead } from '../src/daily.js';
import { extractNumber, cardTitle, cardModel, cardHtml, splitPost, gateCard, pickLayout } from '../src/card.js';

const noSleep = async () => {};

const KAPP = '<b>В Каппадокии обрушилась скала у музея Гёреме: погибли 3 человека, 5 ранены</b>\n\nВо время ливня кусок скалы рухнул на туристической площадке.\n\n<b>Что сейчас:</b> опасную зону закрыли для посетителей.\n\n<blockquote expandable><b>Подробности:</b> обвал произошёл после затяжных дождей. Власти начали проверку соседних маршрутов, погибших 40.</blockquote>';

// ───── 1–2. card without duplication, short title ─────

test('fix 1–2: the card has the figure and a short title, no post text', () => {
  const m = cardModel({ text: 'В Каппадокии обрушилась скала, погибли 3, ранены 5\n\nВо время ливня кусок скалы рухнул на туристической площадке. Площадка закрыта.' });
  assert.equal(m.layout, 'number');
  assert.equal(m.number.text, '3');
  assert.equal(m.number.unit, 'погибших');
  assert.deepEqual(m.number.second, { value: 5, label: 'раненых' });
  assert.equal(m.title, 'В Каппадокии обрушилась скала');
  assert.equal(m.caption, '');
  const html = cardHtml(m);
  assert.doesNotMatch(html, /ливня|Площадка закрыта/);
  assert.match(html, /font-size:(7[0-6]|6\d)px/); // титр крупнее прежних 62
});

test('fix 2: cardTitle cuts at a colon, dash and comma; ≤8 words and ≤70 characters', () => {
  assert.equal(cardTitle('В Каппадокии обрушилась скала у музея Гёреме: погибли 3 человека, 5 ранены'), 'В Каппадокии обрушилась скала у музея Гёреме');
  assert.equal(cardTitle('Власти Вельдании закрыли границу с соседями — туристов развернули'), 'Власти Вельдании закрыли границу с соседями');
  assert.equal(cardTitle('Взрыв на заводе'), 'Взрыв на заводе');
  const long = cardTitle('Министерство транспорта объявило о полной отмене всех рейсов через северные аэропорты страны до понедельника');
  assert.ok(long.split(' ').length <= 8 && long.length <= 70, long);
  assert.doesNotMatch(cardTitle('Правительство решило отложить повышение налога на, '), /[,\s]$/);
});

// ───── 3. figure priority ─────

test('fix 3: casualties outrank percentages and money; number words', () => {
  const a = extractNumber('Погибли 5 человек, разрушено 10% здания, ущерб 2 млн долларов');
  assert.equal(a.kind, 'victims');
  assert.equal(a.text, '5');
  assert.equal(a.unit, 'погибших');
  const k = extractNumber('Обрушилась скала в Каппадокии, погибли 3, ранены 5');
  assert.equal(k.text, '3');
  assert.deepEqual(k.second, { value: 5, label: 'раненых' });
  const w = extractNumber('При обвале погибли двое, трое раненых доставлены в больницу');
  assert.equal(w.text, '2');
  assert.equal(w.unit, 'погибших');
  assert.deepEqual(w.second, { value: 3, label: 'раненых' });
  assert.equal(extractNumber('Ранены пятеро детей').text, '5');
  // percentages without casualties are still percentages
  assert.equal(extractNumber('Бензин подорожал на 8%, рейс на 300 пассажиров').text, '8%');
});

// ───── 8. units ─────

test('fix 8: years, hours, minutes, days, periods, flights, houses, schools, countries', () => {
  const u = (t) => { const n = extractNumber(t); return n && `${n.text} ${n.unit}`; };
  assert.equal(u('Отключили свет в 40 домах на 5 дней'), '40 домов');
  assert.equal(u('Воду отключат на 5 дней'), '5 дней');
  assert.equal(u('Суд приговорил к 12 годам колонии'), '12 лет');
  assert.equal(u('Задержка составила 3 часа'), '3 часа');
  assert.equal(u('Ждали 21 минуту'), '21 минута');
  assert.equal(u('Отменили 120 рейсов'), '120 рейсов');
  assert.equal(u('Закрыли 3 школы'), '3 школы');
  assert.equal(u('Визы отменили для 14 стран'), '14 стран');
  assert.equal(u('Перемирие на двое суток'), null); // number words outside casualties are not extracted
  assert.equal(u('Перемирие на 2 суток'), '2 суток');
  assert.equal(u('В 2026 году власти заявили о планах'), null); // a year is not a duration
  assert.equal(pickLayout('Отключили свет в 40 домах на 5 дней'), 'number');
});

// ───── 6. markup does not reach the card ─────

test('fix 6: the blockquote block and tags do not reach the card or the number', () => {
  const s = splitPost(KAPP);
  assert.match(s.headline, /^В Каппадокии обрушилась скала/);
  assert.doesNotMatch(JSON.stringify(s), /<|Подробности|обвал произошёл/);
  const m = cardModel({ text: KAPP });
  assert.equal(m.number.text, '3'); // "погибших 40" from layer 3 is not picked up
  assert.equal(m.title, 'В Каппадокии обрушилась скала у музея Гёреме');
  assert.doesNotMatch(cardHtml(m), /&lt;b&gt;|<b>|blockquote/);
  assert.equal(gateCard(m).ok, true);
  assert.equal(cardText('<b>Заголовок</b>\n<blockquote>скрыто</blockquote>'), 'Заголовок\n');
});

// ───── 7. no-figure layout ─────

test('fix 7: no figure — title, yellow divider and a short lead line', () => {
  const m = cardModel({ text: '<b>Президент Вельдании объявил об отставке правительства</b>\n\nПравительство уходит в отставку после вотума. Выборы назначат позже.\n\n<b>Что это значит:</b> до выборов страной управляет временный кабинет, который назначит парламент.' });
  assert.equal(m.layout, 'headline');
  assert.equal(m.caption, 'до выборов страной управляет временный кабинет, который назначит парламент');
  assert.ok(m.caption.length <= 90);
  const html = cardHtml(m);
  assert.match(html, /font-weight:900/);
  assert.match(html, /#ffd400/);
  assert.match(html, /font-weight:600/);
  assert.match(html, /до выборов/);
  const long = cardModel({ text: 'Президент выступил с речью\n\n' + 'Очень длинная фраза без точки '.repeat(8) });
  assert.ok(long.caption.length <= 91 && long.caption.endsWith('…'));
  assert.equal(cardModel({ text: 'Президент выступил с речью' }).caption, '');
});

// ───── 5. publishing: HTML ─────

test('fix 5: sanitizeHtml keeps only <b>, <i>, <blockquote [expandable]>', () => {
  assert.equal(sanitizeHtml('<b>да</b> и <i>нет</i>'), '<b>да</b> и <i>нет</i>');
  assert.equal(sanitizeHtml('<B>да</B>'), '<b>да</b>');
  assert.equal(sanitizeHtml('<blockquote expandable>скрыто</blockquote>'), '<blockquote expandable>скрыто</blockquote>');
  assert.equal(sanitizeHtml('цена < 5 & 3 > 2'), 'цена &lt; 5 &amp; 3 &gt; 2');
  assert.equal(sanitizeHtml('<script>x</script><a href="y">z</a>'), '&lt;script&gt;x&lt;/script&gt;&lt;a href="y"&gt;z&lt;/a&gt;');
  assert.equal(sanitizeHtml('<b>не закрыто'), '<b>не закрыто</b>');
  assert.equal(sanitizeHtml('лишнее</b> закрытие'), 'лишнее закрытие');
  assert.equal(sanitizeHtml('<b>перекрёст <i>вложено</b> тут</i>'), '<b>перекрёст <i>вложено</i></b> тут');
  assert.equal(sanitizeHtml('<blockquote>a<blockquote>b</blockquote></blockquote>'), '<blockquote>ab</blockquote>');
  assert.equal(sanitizeHtml('уже &amp; готово'), 'уже &amp; готово');
  assert.equal(visibleText('<b>1 &lt; 2</b> &amp; всё'), '1 < 2 & всё');
  assert.equal(escapeText('a<b>'), 'a&lt;b&gt;');
});

test('fix 5: formatPost sends parse_mode HTML; plain — without markup', () => {
  const t = formatPost('@ch', { text: KAPP });
  assert.equal(t.method, 'sendMessage');
  assert.equal(t.params.parse_mode, 'HTML');
  assert.match(t.params.text, /<blockquote expandable>/);
  const p = formatPost('@ch', { text: '<b>Ж</b> <i>к</i> <u>x</u> 1<2', image: 'a.png' });
  assert.equal(p.params.parse_mode, 'HTML');
  assert.equal(p.params.caption, '<b>Ж</b> <i>к</i> &lt;u&gt;x&lt;/u&gt; 1&lt;2');
  const plain = formatPost('@ch', { text: '<b>Ж</b> 1<2' }, { plain: true });
  assert.equal(plain.params.parse_mode, undefined);
  assert.equal(plain.params.text, 'Ж 1<2');
  // a post without markup is published as before
  assert.equal(formatPost('@ch', { text: 'Привет' }).params.text, 'Привет');
});

test('fix 5: 400 "can\'t parse entities" — retry without markup; the post is not lost', async () => {
  const calls = [];
  const send = async (req) => {
    calls.push(req);
    if (req.params.parse_mode) throw Object.assign(new Error("Bad Request: can't parse entities: Can't find end tag"), { status: 400 });
    return { message_id: 77 };
  };
  const r = await publish({ chat: '@ch', post: { text: '<b>Заголовок</b>\n\nТекст.' }, send, retries: 0, sleep: noSleep });
  assert.equal(r.ok, true);
  assert.equal(r.message_id, 77);
  assert.equal(r.plain, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].params.text, 'Заголовок\n\nТекст.');
  // another 400 — no markup retry needed
  let n = 0;
  const bad = await publish({ chat: '@ch', post: { text: 'x' }, send: async () => { n++; throw Object.assign(new Error('Bad Request: chat not found'), { status: 400 }); }, retries: 2, sleep: noSleep });
  assert.equal(bad.ok, false);
  assert.equal(n, 1);
});

// ───── 9. gate and tags ─────

test('fix 9: the gate counts length and stop-words on visible text', () => {
  const tagged = `<b>${'а'.repeat(500)}</b>\n\n<blockquote expandable>${'б'.repeat(500)}</blockquote>`; // 1002 visible, with tags >1050
  assert.ok(tagged.length > 1024);
  assert.equal(gate({ body: tagged }).ok, true);
  assert.equal(gate({ body: `<b>${'а'.repeat(1030)}</b>` }).ok, false);
  assert.equal(gate({ body: '<b>Что сейчас:</b> по <i>данным</i> властей' }).ok, false); // "по данным" split by tags
  assert.equal(gate({ body: '<blockquote expandable>Это шок для города</blockquote>' }).ok, false);
  assert.equal(gate({ body: '<b>Заголовок</b>\n\nСуть дела.' }).ok, true);
  assert.equal(gate({ body: '<b>Заголовок</b> <a href="https://x.ru">тут</a>' }).ok, false);
  assert.equal(gate({ body: '<b>Заголовок</b> по данным Reuters' }).ok, false);
  assert.equal(gate({ body: 'Пост 1 < 2 без разметки' }).ok, true);
});

test('fix 4: ingest accepts a marked-up post and checks both the whole and the visible part', () => {
  const s = openStore(':memory:');
  s.upsert({ id: 'e1', title: 'Скала', firstSeen: '2026-10-30T10:00:00Z', independentSources: 3, score: 80, reasons: [], needsOwner: false, sources: [{ source: 'x', name: 'X', link: 'https://example.com/1', published: '2026-10-30T10:00:00Z' }] }, '2026-10-30T10:00:00Z');
  s.upsert({ id: 'e2', title: 'Другое', firstSeen: '2026-10-30T10:00:00Z', independentSources: 3, score: 80, reasons: [], needsOwner: false, sources: [{ source: 'x', name: 'X', link: 'https://example.com/2', published: '2026-10-30T10:00:00Z' }] }, '2026-10-30T10:00:00Z');
  const { rows } = ingestPosts(s, [
    { id: 'e1', style: 'срочно', text: KAPP },
    { id: 'e2', style: 'срочно', text: '<b>Заголовок</b>\n\n<blockquote expandable>Подробности: источники сообщают</blockquote>' },
  ]);
  assert.equal(rows[0].ok, true);
  assert.equal(s.getDraft('d-e1').text, KAPP); // the text is stored as is, with markup
  assert.equal(rows[1].ok, false);
  assert.match(rows[1].reasons.join(), /stop-word/);
  s.close();
});

// ───── 10. digests ─────

const items = (n) => Array.from({ length: n }, (_, i) => ({ id: `e${i + 1}`, section: 'war', line: i % 2 ? `Бензин подорожал на 8%: на заправках области выросли цены (${i})` : `Власти Вельдании закрыли границу с соседями ${i}` }));

test('fix 10: boldLead — bold keywords at the start of an item', () => {
  assert.equal(boldLead('Бензин +8%: цены на заправках выросли'), '<b>Бензин +8%:</b> цены на заправках выросли');
  assert.equal(boldLead('Власти закрыли границу — туристов развернули'), '<b>Власти закрыли границу</b> — туристов развернули');
  assert.equal(boldLead('Власти Вельдании закрыли границу с соседями'), '<b>Власти Вельдании закрыли</b> границу с соседями');
  assert.equal(boldLead('Курс <упал> & всё: быстро'), '<b>Курс &lt;упал&gt; &amp; всё:</b> быстро');
});

test('fix 10: in the digest, items from the 4th on go into a collapsible quote', () => {
  const d = buildDigest('утро', items(7));
  assert.match(d.text, /^Главное за ночь\n\n1\. <b>/);
  assert.equal(d.items.length, 7);
  const [open, folded] = d.text.split('<blockquote expandable>');
  assert.equal((open.match(/^\d\. /gm) ?? []).length, 3);
  assert.match(folded, /^4\. <b>/);
  assert.match(folded, /7\. <b>.*<\/blockquote>$/s);
  assert.equal(gate({ body: d.text }).ok, true);
  // three items — no quote
  assert.doesNotMatch(buildDigest('вечер', items(3)).text, /blockquote/);
  assert.match(buildDigest('вечер', items(5)).text, /^Итог дня\n\n1\. <b>[\s\S]*<\/blockquote>\n\nЧто следить завтра: /);
});

test('fix 10: leadOf takes the bold headline of a marked-up post; an old post — as before', () => {
  assert.equal(leadOf(KAPP), 'В Каппадокии обрушилась скала у музея Гёреме: погибли 3 человека, 5 ранены');
  assert.equal(leadOf('Коротко. Ещё одна фраза тут.'), 'Коротко. Ещё одна фраза тут.');
});

test('fix 5: a digest with a 400 on markup goes out without it', async () => {
  const s = openStore(':memory:');
  const first = '2026-10-29T01:00:00.000Z';
  for (let i = 1; i <= 5; i++) {
    s.upsert({ id: `e${i}`, title: `Событие ${i}`, firstSeen: first, independentSources: 3, score: 90 - i, reasons: [], needsOwner: false, sources: [{ source: 'x', name: 'X', link: `https://example.com/${i}`, published: first }] }, first);
    s.setCategory(`e${i}`, ['war', 'science', 'tech', 'economy', 'accidents'][i - 1]);
    s.addDraft({ eventId: `e${i}`, style: 'срочно', text: `<b>Событие номер ${i}: случилось этой ночью в городе</b>\n\nПодробности позже.`, gateOk: true, reasons: [] }, first);
    s.ownerAct(`d-e${i}`, 'одобрил', {}, first);
  }
  s.setTopOfDay(['e1', 'e2', 'e3', 'e4', 'e5'], ['e1', 'e2', 'e3', 'e4', 'e5']);
  const calls = [];
  const send = async (req) => {
    calls.push(req);
    if (req.params.parse_mode) throw Object.assign(new Error("Bad Request: can't parse entities"), { status: 400 });
    return { message_id: 9 };
  };
  const r = await runDaily({ store: s, chat: '@ch', send, now: new Date('2026-10-29T05:00:00Z'), sleep: noSleep });
  assert.equal(r.published, true);
  assert.equal(calls.length, 2);
  assert.doesNotMatch(calls[1].params.text, /<|>/);
  assert.match(calls[1].params.text, /^Главное за ночь\n\n1\. Событие номер/);
  s.close();
});
