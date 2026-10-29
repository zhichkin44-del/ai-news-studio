import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { runDaily, runBreaking, dueDigest, dailyConfig, mskDay, leadOf, buildDigest } from '../src/daily.js';

const noSleep = async () => {};
const utc = (s) => new Date(s);
const okSend = () => {
  const calls = [];
  let id = 500;
  return { calls, send: async (req) => { calls.push(req); return { message_id: ++id }; } };
};
const SECTIONS = ['war', 'science', 'tech', 'economy', 'accidents', 'space', 'health', 'culture'];

/** События с top_of_day и черновиками; first_seen — за ночь до 08:00 МСК 29.10 (05:00Z). */
function fixture(n, { firstSeen = '2026-10-29T01:00:00.000Z', texts = {}, status = 'одобрен', sources = 3, breaking = 0, topOfDay = 1, category } = {}) {
  const s = openStore(':memory:');
  for (let i = 1; i <= n; i++) {
    s.upsert({ id: `e${i}`, title: `Событие ${i}`, firstSeen, independentSources: sources, score: 90 - i, reasons: [], needsOwner: false, sources: [{ source: 'x', name: 'X', link: `https://example.com/${i}`, published: firstSeen }] }, firstSeen);
    s.setCategory(`e${i}`, category ?? SECTIONS[(i - 1) % SECTIONS.length]);
    s.addDraft({ eventId: `e${i}`, style: 'срочно', text: texts[i] ?? `Событие номер ${i} произошло этой ночью. Подробности позже.`, gateOk: true, reasons: [] }, firstSeen);
    if (status === 'одобрен') s.ownerAct(`d-e${i}`, 'одобрил', {}, firstSeen);
  }
  s.setTopOfDay(topOfDay ? Array.from({ length: n }, (_, i) => `e${i + 1}`) : [], Array.from({ length: n }, (_, i) => `e${i + 1}`));
  if (breaking) s.setBreakingFlags(Array.from({ length: n }, (_, i) => `e${i + 1}`), Array.from({ length: n }, (_, i) => `e${i + 1}`));
  return s;
}

test('время дайджеста по МСК и граница суток', () => {
  const cfg = dailyConfig();
  assert.equal(cfg.morning, '08:00');
  assert.equal(dueDigest(Date.parse('2026-10-29T04:59:00Z'), cfg), null); // 07:59 МСК
  assert.equal(dueDigest(Date.parse('2026-10-29T05:00:00Z'), cfg).kind, 'утро'); // 08:00 МСК
  assert.equal(dueDigest(Date.parse('2026-10-29T06:59:00Z'), cfg).kind, 'утро');
  assert.equal(dueDigest(Date.parse('2026-10-29T07:00:00Z'), cfg), null); // окно 120 минут закрыто
  assert.equal(dueDigest(Date.parse('2026-10-29T18:00:00Z'), cfg).kind, 'вечер'); // 21:00 МСК
  // граница суток: 21:30Z 28.10 — уже 29.10 по Москве
  assert.equal(mskDay(Date.parse('2026-10-28T20:59:00Z')), '2026-10-28');
  assert.equal(mskDay(Date.parse('2026-10-28T21:00:00Z')), '2026-10-29');
  assert.equal(dueDigest(Date.parse('2026-10-28T21:00:00Z'), { ...cfg, morning: '00:00' }).day, '2026-10-29');
  // время правится конфигом без кода
  assert.equal(dueDigest(Date.parse('2026-10-29T06:00:00Z'), dailyConfig({ morning: '09:00' })).kind, 'утро');
});

test('утренний дайджест: до 7 пунктов, без ссылок, ≤1024, один раз в сутки', async () => {
  const s = fixture(8);
  const { send, calls } = okSend();
  const at = utc('2026-10-29T05:00:00Z');
  const r = await runDaily({ store: s, chat: '@ch', send, now: at, sleep: noSleep });
  assert.equal(r.published, true);
  assert.equal(r.kind, 'утро');
  assert.equal(calls.length, 1);
  const text = calls[0].params.text;
  assert.match(text, /^Главное за ночь\n\n1\. /);
  assert.equal(text.split('\n').filter((l) => /^(<blockquote expandable>)?\d+\. /.test(l)).length, 7);
  assert.ok(text.length <= 1024);
  assert.doesNotMatch(text, /https?:|example\.com/);
  const again = await runDaily({ store: s, chat: '@ch', send, now: utc('2026-10-29T05:30:00Z'), sleep: noSleep });
  assert.equal(again.published, false);
  assert.match(again.reason, /уже выпущен/);
  assert.equal(calls.length, 1);
  // на следующие сутки — снова можно
  const s2 = fixture(4, { firstSeen: '2026-10-30T01:00:00.000Z' });
  assert.equal((await runDaily({ store: s2, chat: '@ch', send, now: utc('2026-10-30T05:00:00Z'), sleep: noSleep })).published, true);
});

test('дайджест идёт мимо часового лимита обычных постов', async () => {
  const s = fixture(4);
  const { send } = okSend();
  const t = '2026-10-29T05:00:00.000Z';
  // три обычных поста только что — лимит в час исчерпан
  for (const id of ['d-e1', 'd-e2', 'd-e3']) s.markPublished(id, 1, t);
  const r = await runDaily({ store: s, chat: '@ch', send, now: utc(t), sleep: noSleep });
  assert.equal(r.published, true);
});

test('квота по темам: не больше per_group пунктов одной темы', async () => {
  const s = fixture(6, { category: 'war' });
  s.upsert({ id: 'x1', title: 'Наука', firstSeen: '2026-10-29T01:00:00.000Z', independentSources: 2, score: 50, reasons: [], needsOwner: false, sources: [{ source: 'x', link: 'https://example.com/x1', published: '2026-10-29T01:00:00.000Z' }] });
  s.setCategory('x1', 'science');
  s.addDraft({ eventId: 'x1', style: 's', text: 'Учёные нашли новое. Это важно.', gateOk: true, reasons: [] });
  s.setTopOfDay(['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'x1'], ['x1']);
  const { send, calls } = okSend();
  const r = await runDaily({ store: s, chat: '@ch', send, now: utc('2026-10-29T05:00:00Z'), sleep: noSleep });
  assert.equal(r.published, true);
  assert.equal(r.items.length, 3); // 2 войны + 1 наука
  assert.ok(calls[0].params.text.includes('Учёные нашли новое'));
});

test('вечерний «Итог дня»: 5 пунктов и строка «что следить завтра», утренние не повторяются', async () => {
  const s = fixture(12, { firstSeen: '2026-10-29T06:00:00.000Z' });
  const { send, calls } = okSend();
  const m = await runDaily({ store: s, chat: '@ch', send, now: utc('2026-10-29T05:00:00Z'), sleep: noSleep });
  assert.equal(m.published, false); // события появились после 08:00 — к утру их нет
  const e = await runDaily({ store: s, chat: '@ch', send, now: utc('2026-10-29T18:00:00Z'), sleep: noSleep });
  assert.equal(e.published, true);
  const text = calls[0].params.text;
  assert.match(text, /^Итог дня\n\n/);
  assert.equal(text.split('\n').filter((l) => /^(<blockquote expandable>)?\d+\. /.test(l)).length, 5);
  assert.match(text, /\n\nЧто следить завтра: /);
  assert.ok(text.length <= 1024);
});

test('пустой день: меньше трёх подходящих — дайджест не публикуется, бронь не занята', async () => {
  const { send, calls } = okSend();
  const s = fixture(2);
  let r = await runDaily({ store: s, chat: '@ch', send, now: utc('2026-10-29T05:00:00Z'), sleep: noSleep });
  assert.equal(r.published, false);
  assert.match(r.reason, /меньше 3/);
  // не в топе дня — тоже не подходят
  const s2 = fixture(5, { topOfDay: 0 });
  r = await runDaily({ store: s2, chat: '@ch', send, now: utc('2026-10-29T05:00:00Z'), sleep: noSleep });
  assert.equal(r.published, false);
  assert.equal(calls.length, 0);
  assert.equal(s.hasBroadcast('утро', '2026-10-29'), false);
});

test('ворота: пункт со ссылкой или лентой не попадает; сломанная отправка снимает бронь', async () => {
  const s = fixture(4, { texts: { 1: 'Смотрите на https://example.com/1 сегодня.', 2: 'Об этом пишет BBC сегодня.' } });
  const { send, calls } = okSend();
  let r = await runDaily({ store: s, chat: '@ch', send, now: utc('2026-10-29T05:00:00Z'), sleep: noSleep });
  assert.equal(r.published, false); // осталось 2 чистых пункта
  assert.equal(calls.length, 0);
  const s2 = fixture(4);
  const down = async () => { throw Object.assign(new Error('bad'), { status: 400 }); };
  r = await runDaily({ store: s2, chat: '@ch', send: down, now: utc('2026-10-29T05:00:00Z'), sleep: noSleep });
  assert.equal(r.published, false);
  assert.equal(s2.hasBroadcast('утро', '2026-10-29'), false);
  r = await runDaily({ store: s2, chat: '@ch', send, now: utc('2026-10-29T05:10:00Z'), sleep: noSleep });
  assert.equal(r.published, true);
});

test('buildDigest: длинные пункты отбрасываются с конца, итог ≤1024 и проходит ворота', () => {
  const items = Array.from({ length: 7 }, (_, i) => ({ id: `e${i}`, line: `${'слово '.repeat(33).trim()}.`, category: 'war' }));
  const b = buildDigest('утро', items, { minItems: 3 });
  assert.ok(b.text.length <= 1024);
  assert.ok(b.items.length >= 3 && b.items.length < 7);
  assert.equal(buildDigest('утро', items.slice(0, 2), { minItems: 3 }), null);
});

test('leadOf: первая фраза без эмодзи; короткая дополняется второй', () => {
  assert.equal(leadOf('🔥 Взрыв на заводе в городе, власти проверяют причины и масштаб повреждений на месте. Второе предложение.'), 'Взрыв на заводе в городе, власти проверяют причины и масштаб повреждений на месте.');
  assert.equal(leadOf('Коротко. Ещё одна фраза тут.'), 'Коротко. Ещё одна фраза тут.');
});

test('«срочно»: breaking=1, ≥3 независимых издателей, одобренный черновик; с шапкой', async () => {
  const now = utc('2026-10-29T01:30:00Z');
  const { send, calls } = okSend();
  const s = fixture(1, { breaking: 1, sources: 3 });
  const r = await runBreaking({ store: s, chat: '@ch', send, now, sleep: noSleep });
  assert.equal(r.published.length, 1);
  assert.ok(calls[0].params.text.startsWith('⚡️ СРОЧНО\n\n'));
  assert.equal(s.getDraft('d-e1').status, 'опубликован');
  // без второго независимого издателя (2 < 3) срочным не бывает
  const s2 = fixture(1, { breaking: 1, sources: 2 });
  assert.equal((await runBreaking({ store: s2, chat: '@ch', send, now, sleep: noSleep })).published.length, 0);
  // не breaking
  const s3 = fixture(1, { breaking: 0, sources: 5 });
  assert.equal((await runBreaking({ store: s3, chat: '@ch', send, now, sleep: noSleep })).published.length, 0);
  // не одобрен
  const s4 = fixture(1, { breaking: 1, sources: 4, status: 'ждёт одобрения' });
  assert.equal((await runBreaking({ store: s4, chat: '@ch', send, now, sleep: noSleep })).published.length, 0);
  assert.equal(calls.length, 1);
});

test('«срочно»: не чаще раза в 30 минут, не более 6 в сутки, повтора нет', async () => {
  const s = fixture(8, { breaking: 1, sources: 3, firstSeen: '2026-10-29T01:00:00.000Z' });
  const { send, calls } = okSend();
  const cfg = { breaking: { max_age_minutes: 100000 } };
  const at = (min) => new Date(Date.parse('2026-10-29T01:00:00Z') + min * 60_000);
  let r = await runBreaking({ store: s, chat: '@ch', send, config: cfg, now: at(0), sleep: noSleep });
  assert.equal(r.published.length, 1); // за проход — одно
  assert.equal(r.stopped, 'пауза');
  r = await runBreaking({ store: s, chat: '@ch', send, config: cfg, now: at(29), sleep: noSleep });
  assert.equal(r.published.length, 0);
  r = await runBreaking({ store: s, chat: '@ch', send, config: cfg, now: at(30), sleep: noSleep });
  assert.equal(r.published.length, 1);
  for (let k = 2; k < 6; k++) await runBreaking({ store: s, chat: '@ch', send, config: cfg, now: at(30 * k), sleep: noSleep });
  assert.equal(calls.length, 6);
  r = await runBreaking({ store: s, chat: '@ch', send, config: cfg, now: at(30 * 6), sleep: noSleep });
  assert.equal(r.published.length, 0);
  assert.equal(r.stopped, 'лимит в сутки');
  // следующие сутки по МСК (00:00 МСК = 21:00Z) — снова можно
  r = await runBreaking({ store: s, chat: '@ch', send, config: cfg, now: new Date('2026-10-29T21:00:00Z'), sleep: noSleep });
  assert.equal(r.published.length, 1);
  assert.equal(new Set(calls.map((c) => c.params.text)).size, 7);
});

test('«срочно»: вне часовой очереди — лимит обычных постов не расходуется; устаревшее не уходит; ворота', async () => {
  const s = fixture(1, { breaking: 1, sources: 3 });
  const { send, calls } = okSend();
  const now = utc('2026-10-29T01:30:00Z');
  await runBreaking({ store: s, chat: '@ch', send, now, sleep: noSleep });
  assert.equal(s.publishedTimes().length, 0);
  // старше max_age_minutes
  const old = fixture(1, { breaking: 1, sources: 3 });
  const r = await runBreaking({ store: old, chat: '@ch', send, now: utc('2026-10-29T10:00:00Z'), sleep: noSleep });
  assert.equal(r.published.length, 0);
  assert.equal(r.skipped[0].reason, 'устарело');
  // текст со ссылкой — ворота, ничего не отправлено, бронь снята
  const bad = fixture(1, { breaking: 1, sources: 3, texts: { 1: 'Смотрите https://example.com/1 сейчас.' } });
  const rb = await runBreaking({ store: bad, chat: '@ch', send, now, sleep: noSleep });
  assert.equal(rb.published.length, 0);
  assert.equal(bad.hasBroadcast('срочно', 'd-e1'), false);
  assert.equal(calls.length, 1);
});
