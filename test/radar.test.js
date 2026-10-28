import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pollOnce, runRadar, parseArgs } from '../src/radar.js';
import { fetchFeed } from '../src/collect.js';
import { openStore } from '../src/store.js';

const item = (source, n, published = '2026-10-28T10:00:00.000Z') => ({ id: `${source}:${n}`, title: `Заголовок ${n}`, summary: '', link: `https://x/${source}/${n}`, source, published });
const SRC = [{ id: 'a' }, { id: 'b' }];
const tmp = () => mkdtempSync(join(tmpdir(), 'radar-'));

test('first_seen ставится при первом виде и не меняется при повторе; дублей нет', async () => {
  const dir = tmp();
  const store = openStore(':memory:');
  const loader = async (s) => [item(s.id, 1), item(s.id, 2)];
  const log = join(dir, 'err.log');
  await pollOnce(SRC, { store, loader, logPath: log, now: () => new Date('2026-10-28T10:01:00Z') });
  const again = await pollOnce(SRC, { store, loader, logPath: log, now: () => new Date('2026-10-28T10:03:00Z') });
  const rows = store.itemsSince('2000-01-01');
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.first_seen === '2026-10-28T10:01:00.000Z' && r.published === '2026-10-28T10:00:00.000Z'));
  assert.ok(again.every((s) => s.added === 0));
  rmSync(dir, { recursive: true });
});

test('первый опрос ленты — baseline, новые записи позже — нет', async () => {
  const dir = tmp();
  const store = openStore(':memory:');
  let batch = [item('a', 1)];
  const loader = async () => batch;
  const opts = { store, loader, logPath: join(dir, 'e.log') };
  await pollOnce([{ id: 'a' }], opts);
  batch = [item('a', 1), item('a', 2)];
  await pollOnce([{ id: 'a' }], opts);
  const byId = Object.fromEntries(store.itemsSince('2000-01-01').map((r) => [r.id, r.baseline]));
  assert.deepEqual(byId, { 'a:1': 1, 'a:2': 0 });
  rmSync(dir, { recursive: true });
});

test('ошибка и пустой ответ пишутся в журнал, остальные ленты не страдают', async () => {
  const dir = tmp();
  const log = join(dir, 'sub', 'radar-errors.log');
  const store = openStore(':memory:');
  const loader = async (s) => {
    if (s.id === 'bad') throw new Error('HTTP 503');
    if (s.id === 'empty') return [];
    return [item(s.id, 1)];
  };
  const res = await pollOnce([{ id: 'bad' }, { id: 'empty' }, { id: 'ok' }], { store, loader, logPath: log });
  assert.deepEqual(res.map((r) => r.ok), [false, false, true]);
  assert.equal(store.itemsSince('2000-01-01').length, 1);
  const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.source), ['bad', 'empty']);
  assert.match(lines[0].error, /503/);
  assert.match(lines[1].error, /пуст/);
  const polls = store.pollsSince('2000-01-01');
  assert.equal(polls.filter((p) => !p.ok).length, 2);
  rmSync(dir, { recursive: true });
});

test('без ошибок журнал не создаётся', async () => {
  const dir = tmp();
  const log = join(dir, 'none.log');
  await pollOnce([{ id: 'a' }], { store: openStore(':memory:'), loader: async () => [item('a', 1)], logPath: log });
  assert.equal(existsSync(log), false);
  rmSync(dir, { recursive: true });
});

test('разбор фикстуры RSS через fetchFeed с подменой сети', async () => {
  const xml = readFileSync(new URL('./fixtures/a.rss.xml', import.meta.url), 'utf8');
  const fetchImpl = async () => ({ ok: true, text: async () => xml });
  const items = await fetchFeed({ id: 'a', url: 'http://x' }, { fetchImpl });
  assert.ok(items.length > 0);
  const store = openStore(':memory:');
  await pollOnce([{ id: 'a' }], { store, loader: async () => items, logPath: join(tmp(), 'e.log') });
  assert.equal(store.itemsSince('2000-01-01').length, items.length);
});

test('runRadar: --once делает один проход; --for ограничивает число проходов', async () => {
  const store = openStore(':memory:');
  const loader = async () => [item('a', 1)];
  const logPath = join(tmp(), 'e.log');
  let t = 0;
  const clock = () => t;
  const sleep = async (ms) => { t += ms; };
  assert.equal(await runRadar({ sources: [{ id: 'a' }], store, loader, logPath, once: true, clock, sleep }), 1);
  assert.equal(t, 0);
  // 300 с при шаге 120 с: проходы в 0, 120, 240 — следующий вышел бы за 300
  assert.equal(await runRadar({ sources: [{ id: 'a' }], store, loader, logPath, forSec: 300, clock, sleep }), 3);
});

test('parseArgs', () => {
  assert.deepEqual(parseArgs(['--once']), { once: true, forSec: null });
  assert.deepEqual(parseArgs(['--for', '90']), { once: false, forSec: 90 });
  assert.throws(() => parseArgs(['--for']));
  assert.throws(() => parseArgs(['--bogus']));
});
