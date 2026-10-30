import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { attachImage } from '../src/images.js';
import { formatPost } from '../src/publish.js';
import { extractNumber, pickLayout, wrapText, fitText, splitPost, labelFor, cardModel, cardHtml, gateCard, renderCard, findBrowser, cardModeOf, brandOf, CardError, LABELS, iconSvg } from '../src/card.js';

test('число: процент, сумма, жертвы, величина; годы не считаются', () => {
  assert.deepEqual(extractNumber('Инфляция выросла на 12,5% за месяц'), { text: '12,5%', unit: '', kind: 'percent', value: 12.5, share: 0.125 });
  const m = extractNumber('Банк выделит 5 млрд долларов на проект');
  assert.equal(m.text, '$5 млрд');
  assert.equal(m.kind, 'money');
  assert.equal(extractNumber('Цена составит 300 рублей').text, '300 ₽');
  const v = extractNumber('Не менее 30 человек погибли, 80 ранены.');
  assert.equal(v.text, '30');
  assert.equal(v.unit, 'погибших');
  assert.deepEqual(v.second, { value: 80, label: 'раненых' });
  assert.equal(extractNumber('Погибли 12 человек').text, '12');
  assert.equal(extractNumber('Магнитуда землетрясения: магнитудой 6,5').text, '6,5');
  assert.equal(extractNumber('В 2026 году 1 ноября власти заявили о планах'), null);
  assert.equal(extractNumber('Президент выступил с речью'), null);
});

test('выбор макета: цифра или заголовок', () => {
  assert.equal(pickLayout('Взрыв: 5 погибших'), 'number');
  assert.equal(pickLayout('Президент выступил с речью'), 'headline');
  assert.equal(cardModel({ text: 'Президент выступил\n\nПодробности позже.' }).caption, 'Подробности позже'); // без цифры — короткая строка главного
});

test('перенос по словам и сжатие кегля', () => {
  assert.deepEqual(wrapText('один два три четыре', 9), ['один два', 'три', 'четыре']);
  assert.deepEqual(wrapText('сверхдлинноеслово', 6), ['сверхд', 'линное', 'слово']);
  const short = fitText('Короткий заголовок', { width: 920, maxLines: 3, maxSize: 100, minSize: 40 });
  const long = fitText('Очень длинный заголовок про то, как что-то случилось в далёкой стране на прошлой неделе', { width: 920, maxLines: 3, maxSize: 100, minSize: 40 });
  assert.ok(short.size > long.size);
  assert.ok(long.lines.length <= 3);
  const huge = fitText('слово '.repeat(200), { width: 920, maxLines: 3, maxSize: 100, minSize: 40 });
  assert.equal(huge.lines.length, 3);
  assert.ok(huge.lines[2].endsWith('…'));
  for (const l of huge.lines) assert.ok(l.length * huge.size * 0.6 <= 920 + huge.size);
});

test('заголовок — первая строка; подпись — первая фраза', () => {
  const s = splitPost('⚡️ Столкновение поездов в Испании.\n\nПоезда столкнулись под Толедо. Есть жертвы. Третья фраза.');
  assert.equal(s.headline, 'Столкновение поездов в Испании');
  assert.ok(s.caption.startsWith('Поезда столкнулись'));
});

test('метка категории', () => {
  assert.equal(labelFor('Взрыв на заводе', null), 'ЧП');
  assert.equal(labelFor('Нефть подешевела', 'world'), 'Деньги');
  assert.equal(labelFor('Открыт новый вид', 'science'), 'Наука');
  assert.equal(labelFor('Выборы в стране', null), 'Мир');
  // слова о жертвах в теле поста метку не меняют: смотрим только заголовок
  assert.equal(cardModel({ text: 'Семьи в лагерях Газы готовятся к зиме\n\nПогибли и ранены тысячи, жертв много.' }).label, 'Мир');
  assert.equal(cardModel({ text: 'Взрыв на заводе\n\nПодробности позже.' }).label, 'ЧП');
  for (const l of LABELS) assert.match(iconSvg(l), /<svg/);
});

test('ворота по тексту карточки: ссылки и издания не проходят', () => {
  assert.equal(gateCard(cardModel({ text: 'Заголовок\n\nПодпись.' })).ok, true);
  assert.equal(gateCard(cardModel({ text: 'Заголовок https://x.ru/a' })).ok, false);
  assert.equal(gateCard(cardModel({ text: 'Заголовок про выборы\n\nпо сообщению Reuters' })).ok, false);
  const html = cardHtml(cardModel({ text: 'Рынок упал на 7%\n\nИндекс снизился.' }));
  assert.match(html, /1080px/);
  assert.match(html, /ZHICHKIN NEWS/);
  assert.doesNotMatch(html.replace('http://www.w3.org/2000/svg', ''), /https?:/);
});

test('бренд и режим читаются из конфига, режим по умолчанию fallback', () => {
  assert.equal(brandOf({ brand: 'ИКС' }), 'ИКС');
  assert.equal(cardModeOf({}), 'fallback');
  assert.equal(cardModeOf({ card_mode: 'always' }), 'always');
  assert.equal(cardModeOf({ card_mode: 'мусор' }), 'fallback');
});

test('нет браузера — понятная ошибка, а не падение', async () => {
  assert.equal(findBrowser({ env: {}, exists: () => false }), null);
  assert.equal(findBrowser({ env: { CARD_BROWSER: 'C:/x/chrome.exe' }, exists: () => false }), null);
  assert.equal(findBrowser({ env: { PROGRAMFILES: 'C:/PF' }, exists: (p) => p.endsWith('Edge/Application/msedge.exe') }), 'C:/PF/Microsoft/Edge/Application/msedge.exe');
  await assert.rejects(renderCard({ text: 'Заголовок' }, { browser: null, outFile: 'x.png' }), (e) => e instanceof CardError && e.code === 'no-browser' && /Chrome\/Edge/.test(e.message));
  await assert.rejects(renderCard({ text: 'Заголовок https://x.ru' }, { browser: 'b', outFile: 'x.png' }), (e) => e.code === 'gate');
});

// PNG-заглушка нужного размера вместо браузера
const fakePng = (tail = 'a') => {
  const b = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(1080, 16); b.writeUInt32BE(1350, 20); b.write(tail, 30);
  return b;
};
const fakeExec = async (_exe, args) => {
  const out = args.find((a) => a.startsWith('--screenshot=')).slice('--screenshot='.length);
  await writeFile(out, fakePng());
};

test('renderCard: вызывает браузер и возвращает файл 1080×1350', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cardt-'));
  const r = await renderCard({ text: 'Рынок упал на 7%\n\nИндекс снизился.' }, { browser: 'fake', outFile: join(dir, 'a.png'), exec: fakeExec });
  assert.equal(r.width, 1080);
  assert.equal(r.height, 1350);
  assert.equal(r.layout, 'number');
});

test('images: режимы card_mode — fallback, always, off', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cardi-'));
  const store = openStore(':memory:');
  const draft = (id) => ({ id, event_id: 'e-none', text: 'Рынок упал на 7%\n\nИндекс снизился.', created_at: '2026-10-30T10:00:00Z' });
  const render = (p, o) => renderCard(p, { ...o, browser: 'fake', exec: fakeExec });
  const noNet = async () => { throw new Error('нет сети'); };
  const a = await attachImage(store, draft('d1'), { dir, fetchImpl: noNet, render, config: { card_mode: 'fallback' } });
  assert.equal(a.source, 'card');
  assert.equal(a.url, 'card:d1');
  assert.equal(a.width, 1080);
  assert.equal((await attachImage(store, draft('d1'), { dir, render })).id, a.id); // повтор — no-op
  const b = await attachImage(store, draft('d2'), { dir, fetchImpl: noNet, render, config: { card_mode: 'off' } });
  assert.equal(b, null);
  const c = await attachImage(store, draft('d3'), { dir, fetchImpl: () => { throw new Error('фото не должно запрашиваться'); }, render, config: { card_mode: 'always' } });
  assert.equal(c.source, 'card');
  store.close();
});

test('публикация карточки: sendPhoto с подписью = текст поста', () => {
  const req = formatPost('@ch', { text: 'Текст поста', image: 'data/images/card-d1.png' });
  assert.equal(req.method, 'sendPhoto');
  assert.equal(req.params.caption, 'Текст поста');
  assert.equal(req.params.photo, 'data/images/card-d1.png');
});
