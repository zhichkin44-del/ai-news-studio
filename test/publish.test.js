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

test('format: sendMessage without a picture, sendPhoto with a caption when there is one', () => {
  assert.equal(formatPost('@ch', { text: 'Привет' }).method, 'sendMessage');
  const p = formatPost('@ch', { text: 'Привет', image: 'data/images/a.jpg' });
  assert.equal(p.method, 'sendPhoto');
  assert.equal(p.params.caption, 'Привет');
  assert.equal(p.params.photo, 'data/images/a.jpg');
});

test('gate: link, feed name, length — nothing is sent', async () => {
  for (const text of ['Читайте на https://example.com/1', 'Об этом написал BBC', 'а'.repeat(1025), '']) {
    const { send, calls } = okSend();
    const r = await publish({ chat: '@ch', post: { text }, send });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'gate');
    assert.equal(calls.length, 0);
  }
});

test('publish: success returns message_id; no chat — config', async () => {
  const { send } = okSend();
  assert.deepEqual(await publish({ chat: '@ch', post: { text: 'Нормальный пост' }, send }), { ok: true, message_id: 101 });
  assert.equal((await publish({ chat: '', post: { text: 'Пост' }, send })).reason, 'config');
});

test('retry on a network error, then success', async () => {
  let n = 0;
  const send = async () => { if (++n < 3) throw new Error('ECONNRESET'); return { message_id: 7 }; };
  const r = await publish({ chat: '@ch', post: { text: 'Пост' }, send, retries: 2, sleep: noSleep });
  assert.deepEqual(r, { ok: true, message_id: 7 });
  assert.equal(n, 3);
});

test('retries exhausted — retryable error; 400 is not retried', async () => {
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

test('queue: only approved items; the others are untouched', async () => {
  const s = fixture(2, { approve: false });
  s.ownerAct('d-e2', 'одобрил', {}, T0.toISOString());
  const { send, calls } = okSend();
  const r = await runQueue({ store: s, chat: '@ch', send, now: T0, sleep: noSleep });
  assert.deepEqual(r.published.map((p) => p.id), ['d-e2']);
  assert.equal(calls.length, 1);
  assert.equal(s.getDraft('d-e1').status, 'ждёт одобрения');
});

test('publishing: status «опубликован» (published) and message_id in drafts', async () => {
  const s = fixture(1);
  const { send } = okSend();
  await runQueue({ store: s, chat: '@ch', send, now: T0, sleep: noSleep });
  const d = s.getDraft('d-e1');
  assert.equal(d.status, 'опубликован');
  assert.equal(d.message_id, '101');
  assert.equal(d.published_at, T0.toISOString());
});

test('pause between posts: the second is not earlier than M minutes', async () => {
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

test('limit N per hour: default 3, adjustable via config', async () => {
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

test('duplicates: a repeat pass does not publish the same post; markPublished fires once', async () => {
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

test('gate in the queue: a bad post is skipped, the next one goes out, status unchanged', async () => {
  const s = fixture(2, { texts: ['Смотрите https://example.com/x', 'Хороший пост'] });
  const { send, calls } = okSend();
  const r = await runQueue({ store: s, chat: '@ch', send, config: { min_gap_minutes: 0 }, now: T0, sleep: noSleep });
  assert.deepEqual(r.published.map((p) => p.id), ['d-e2']);
  assert.equal(r.skipped[0].id, 'd-e1');
  assert.equal(s.getDraft('d-e1').status, 'одобрен');
  assert.equal(calls.length, 1);
});

test('network error: the post stays «одобрен», the pass stops, then it goes out', async () => {
  const s = fixture(1);
  const down = async () => { throw new Error('ENOTFOUND'); };
  let r = await runQueue({ store: s, chat: '@ch', send: down, config: { retries: 1 }, now: T0, sleep: noSleep });
  assert.equal(r.stopped, 'сеть');
  assert.equal(s.getDraft('d-e1').status, 'одобрен');
  const { send } = okSend();
  r = await runQueue({ store: s, chat: '@ch', send, now: at(1), sleep: noSleep });
  assert.equal(r.published.length, 1);
});

test('a picture from the images table goes via sendPhoto; a foreign mode does not publish', async () => {
  const s = fixture(1);
  s.addImage({ draftId: 'd-e1', file: 'data/images/d-e1.jpg', sha256: 'h', url: 'https://img.example/a.jpg', source: 'feed' }, T0.toISOString());
  const { send, calls } = okSend();
  let r = await runQueue({ store: s, chat: '@ch', send, config: { mode: 'авто' }, now: T0, sleep: noSleep });
  assert.equal(calls.length, 0);
  assert.match(r.stopped, /режим/);
  await runQueue({ store: s, chat: '@ch', send, now: T0, sleep: noSleep, mark: async () => ({ file: 'data/images/wm/d-e1.jpg' }) });
  assert.equal(calls[0].method, 'sendPhoto');
  assert.equal(calls[0].params.photo, 'data/images/wm/d-e1.jpg');
});

test('duplicates: if the «опубликован» mark is not written, the post does not go out a second time (29.10: one post went out six times)', async () => {
  const s = fixture(1);
  const real = s.markPublished;
  s.markPublished = () => { throw new Error('database is locked'); };
  const { send, calls } = okSend();
  const first = await runQueue({ store: s, chat: '@ch', send, now: at(0), sleep: noSleep });
  assert.equal(calls.length, 1);
  assert.ok(first.skipped.some((x) => /отметка не записалась/.test(x.reason)));
  s.markPublished = real;
  const again = await runQueue({ store: s, chat: '@ch', send, now: at(120), sleep: noSleep });
  assert.equal(calls.length, 1, 'not sent a second time');
  assert.ok(again.skipped.some((x) => x.reason === 'уже отправлялся'));
});

test('duplicates: not sent due to the network — the reservation is released; the next pass retries', async () => {
  const s = fixture(1);
  let n = 0;
  const send = async () => { n++; if (n === 1) throw new Error('сеть'); return { message_id: 7 }; };
  const a = await runQueue({ store: s, chat: '@ch', send, now: at(0), sleep: noSleep, config: { retries: 0 } });
  assert.equal(a.stopped, 'сеть');
  const b = await runQueue({ store: s, chat: '@ch', send, now: at(120), sleep: noSleep, config: { retries: 0 } });
  assert.equal(b.published.length, 1);
});

test('watermark: a relative picture path is resolved from the repository root (baseDir), otherwise the post would go out as text', async () => {
  const s = fixture(1);
  s.addImage({ draftId: 'd-e1', eventId: 'e1', file: 'data/images/a.jpg', sha256: 'x', url: 'u', source: 'feed' });
  const seen = [];
  const mark = async (file) => { seen.push(file); return { file }; };
  const { send, calls } = okSend();
  await runQueue({ store: s, chat: '@ch', send, now: at(0), sleep: noSleep, baseDir: 'C:/repo', mark });
  assert.match(seen[0].split('\\').join('/'), /^C:\/repo\/data\/images\/a\.jpg$/);
  assert.equal(calls[0].method, 'sendPhoto');
});
