import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { publish, runQueue, formatPost } from '../src/publish.js';

const T0 = new Date('2026-10-29T10:00:00.000Z');
const at = (min) => new Date(T0.getTime() + min * 60_000);
const noSleep = async () => {};

function fixture(n = 3, { approve = true, texts = [] } = {}) {
  const s = openStore(':memory:');
  for (let i = 1; i <= n; i++) {
    s.upsert({ id: `e${i}`, title: `Событие ${i}`, firstSeen: T0.toISOString(), independentSources: 2, score: 70, reasons: [], needsOwner: false, sources: [{ source: 'x', name: 'X', link: `https://example.com/${i}`, published: T0.toISOString() }] }, T0.toISOString());
    s.addDraft({ eventId: `e${i}`, style: 'срочно', text: texts[i - 1] ?? `Текст поста ${i}`, gateOk: true, reasons: [] }, `2026-10-29T09:0${i}:00.000Z`);
    if (approve) s.ownerAct(`d-e${i}`, 'одобрил', {}, T0.toISOString());
  }
  return s;
}

const okSend = () => {
  const calls = [];
  let id = 100;
  const send = async (req) => { calls.push(req); return { message_id: ++id }; };
  return { send, calls };
};

test('формат: без картинки sendMessage, с картинкой sendPhoto с подписью', () => {
  assert.equal(formatPost('@ch', { text: 'Привет' }).method, 'sendMessage');
  const p = formatPost('@ch', { text: 'Привет', image: 'data/images/a.jpg' });
  assert.equal(p.method, 'sendPhoto');
  assert.equal(p.params.caption, 'Привет');
  assert.equal(p.params.photo, 'data/images/a.jpg');
});

test('ворота: ссылка, лента, длина — ничего не отправляется', async () => {
  for (const text of ['Читайте на https://example.com/1', 'Об этом написал BBC', 'а'.repeat(1025), '']) {
    const { send, calls } = okSend();
    const r = await publish({ chat: '@ch', post: { text }, send });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'gate');
    assert.equal(calls.length, 0);
  }
});

test('publish: успех возвращает message_id; нет чата — config', async () => {
  const { send } = okSend();
  assert.deepEqual(await publish({ chat: '@ch', post: { text: 'Нормальный пост' }, send }), { ok: true, message_id: 101 });
  assert.equal((await publish({ chat: '', post: { text: 'Пост' }, send })).reason, 'config');
});

test('повтор при сетевой ошибке, затем успех', async () => {
  let n = 0;
  const send = async () => { if (++n < 3) throw new Error('ECONNRESET'); return { message_id: 7 }; };
  const r = await publish({ chat: '@ch', post: { text: 'Пост' }, send, retries: 2, sleep: noSleep });
  assert.deepEqual(r, { ok: true, message_id: 7 });
  assert.equal(n, 3);
});

test('повторы исчерпаны — ошибка retryable; 400 не повторяется', async () => {
  let n = 0;
  const bad = async () => { n++; throw new Error('timeout'); };
  const r = await publish({ chat: '@ch', post: { text: 'Пост' }, send: bad, retries: 2, sleep: noSleep });
  assert.equal(r.ok, false);
  assert.equal(r.retryable, true);
  assert.equal(n, 3);
  n = 0;
  const r400 = await publish({ chat: '@ch', post: { text: 'Пост' }, send: async () => { n++; throw Object.assign(new Error('chat not found'), { status: 400 }); }, sleep: noSleep });
  assert.equal(r400.retryable, false);
  assert.equal(n, 1);
});

test('очередь: только одобренные, остальные не трогаются', async () => {
  const s = fixture(2, { approve: false });
  s.ownerAct('d-e2', 'одобрил', {}, T0.toISOString());
  const { send, calls } = okSend();
  const r = await runQueue({ store: s, chat: '@ch', send, now: T0, sleep: noSleep });
  assert.deepEqual(r.published.map((p) => p.id), ['d-e2']);
  assert.equal(calls.length, 1);
  assert.equal(s.getDraft('d-e1').status, 'ждёт одобрения');
});

test('публикация: статус «опубликован» и message_id в drafts', async () => {
  const s = fixture(1);
  const { send } = okSend();
  await runQueue({ store: s, chat: '@ch', send, now: T0, sleep: noSleep });
  const d = s.getDraft('d-e1');
  assert.equal(d.status, 'опубликован');
  assert.equal(d.message_id, '101');
  assert.equal(d.published_at, T0.toISOString());
});

test('пауза между постами: второй не раньше M минут', async () => {
  const s = fixture(2);
  const { send, calls } = okSend();
  const cfg = { min_gap_minutes: 20 };
  let r = await runQueue({ store: s, chat: '@ch', send, config: cfg, now: T0, sleep: noSleep });
  assert.equal(r.published.length, 1);
  assert.equal(r.stopped, 'пауза');
  r = await runQueue({ store: s, chat: '@ch', send, config: cfg, now: at(19), sleep: noSleep });
  assert.equal(r.published.length, 0);
  r = await runQueue({ store: s, chat: '@ch', send, config: cfg, now: at(20), sleep: noSleep });
  assert.equal(r.published.length, 1);
  assert.equal(calls.length, 2);
});

test('лимит N в час: по умолчанию 3, правится конфигом', async () => {
  const s = fixture(5);
  const { send, calls } = okSend();
  const cfg = { min_gap_minutes: 0 };
  let r = await runQueue({ store: s, chat: '@ch', send, config: cfg, now: T0, sleep: noSleep });
  assert.equal(r.published.length, 3);
  assert.equal(r.stopped, 'лимит в час');
  r = await runQueue({ store: s, chat: '@ch', send, config: cfg, now: at(59), sleep: noSleep });
  assert.equal(r.published.length, 0);
  r = await runQueue({ store: s, chat: '@ch', send, config: { ...cfg, max_per_hour: 4 }, now: at(59), sleep: noSleep });
  assert.equal(r.published.length, 1);
  r = await runQueue({ store: s, chat: '@ch', send, config: cfg, now: at(61), sleep: noSleep });
  assert.equal(r.published.length, 1);
  assert.equal(calls.length, 5);
});

test('дубли: повторный проход не публикует то же; markPublished срабатывает один раз', async () => {
  const s = fixture(1);
  const { send, calls } = okSend();
  const cfg = { min_gap_minutes: 0 };
  await runQueue({ store: s, chat: '@ch', send, config: cfg, now: T0, sleep: noSleep });
  const r = await runQueue({ store: s, chat: '@ch', send, config: cfg, now: at(5), sleep: noSleep });
  assert.equal(r.published.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(s.markPublished('d-e1', 999), false);
  assert.equal(s.getDraft('d-e1').message_id, '101');
});

test('ворота в очереди: плохой пост пропущен, следующий уходит, статус не меняется', async () => {
  const s = fixture(2, { texts: ['Смотрите https://example.com/x', 'Хороший пост'] });
  const { send, calls } = okSend();
  const r = await runQueue({ store: s, chat: '@ch', send, config: { min_gap_minutes: 0 }, now: T0, sleep: noSleep });
  assert.deepEqual(r.published.map((p) => p.id), ['d-e2']);
  assert.equal(r.skipped[0].id, 'd-e1');
  assert.equal(s.getDraft('d-e1').status, 'одобрен');
  assert.equal(calls.length, 1);
});

test('сетевая ошибка: пост остаётся «одобрен», проход останавливается, потом уходит', async () => {
  const s = fixture(1);
  const down = async () => { throw new Error('ENOTFOUND'); };
  let r = await runQueue({ store: s, chat: '@ch', send: down, config: { retries: 1 }, now: T0, sleep: noSleep });
  assert.equal(r.stopped, 'сеть');
  assert.equal(s.getDraft('d-e1').status, 'одобрен');
  const { send } = okSend();
  r = await runQueue({ store: s, chat: '@ch', send, now: at(1), sleep: noSleep });
  assert.equal(r.published.length, 1);
});

test('картинка из таблицы images уходит sendPhoto; чужой режим не публикует', async () => {
  const s = fixture(1);
  s.addImage({ draftId: 'd-e1', file: 'data/images/d-e1.jpg', sha256: 'h', url: 'https://img.example/a.jpg', source: 'feed' }, T0.toISOString());
  const { send, calls } = okSend();
  let r = await runQueue({ store: s, chat: '@ch', send, config: { mode: 'авто' }, now: T0, sleep: noSleep });
  assert.equal(calls.length, 0);
  assert.match(r.stopped, /режим/);
  await runQueue({ store: s, chat: '@ch', send, now: T0, sleep: noSleep });
  assert.equal(calls[0].method, 'sendPhoto');
});
