import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pollOnce, runRadar, parseArgs } from '../src/radar.js';
import { fetchFeed, decodeBuffer } from '../src/collect.js';
import { openStore } from '../src/store.js';

const item = (source, n, published = '2026-10-28T10:00:00.000Z') => ({ id: `${source}:${n}`, title: `Заголовок ${n}`, summary: '', link: `https://x/${source}/${n}`, source, published });
const SRC = [{ id: 'a' }, { id: 'b' }];
const tmp = () => mkdtempSync(join(tmpdir(), 'radar-'));

test('first_seen is set on first sight and does not change on a repeat; no duplicates', async () => {
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

test('the first poll of a feed is baseline; later new records are not', async () => {
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

test('an error and an empty response are written to the log; other feeds are unaffected', async () => {
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
  assert.match(lines[1].error, /empty/);
  const polls = store.pollsSince('2000-01-01');
  assert.equal(polls.filter((p) => !p.ok).length, 2);
  rmSync(dir, { recursive: true });
});

test('no log is created when there are no errors', async () => {
  const dir = tmp();
  const log = join(dir, 'none.log');
  await pollOnce([{ id: 'a' }], { store: openStore(':memory:'), loader: async () => [item('a', 1)], logPath: log });
  assert.equal(existsSync(log), false);
  rmSync(dir, { recursive: true });
});

test('windows-1251: the charset header and XML declaration are decoded', () => {
  const hello = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]); // «Привет» в cp1251
  assert.equal(decodeBuffer(hello, 'application/xml; charset=cp1251'), 'Привет');
  const xml = Buffer.concat([Buffer.from('<?xml version="1.0" encoding="windows-1251"?>'), hello]);
  assert.equal(decodeBuffer(xml, 'application/xml').slice(-6), 'Привет');
  assert.equal(decodeBuffer(Buffer.from('Привет', 'utf8'), 'application/xml'), 'Привет');
});

test('RSS fixture parsed via fetchFeed with a stubbed network', async () => {
  const xml = readFileSync(new URL('./fixtures/a.rss.xml', import.meta.url), 'utf8');
  const fetchImpl = async () => ({ ok: true, text: async () => xml });
  const items = await fetchFeed({ id: 'a', url: 'http://x' }, { fetchImpl });
  assert.ok(items.length > 0);
  const store = openStore(':memory:');
  await pollOnce([{ id: 'a' }], { store, loader: async () => items, logPath: join(tmp(), 'e.log') });
  assert.equal(store.itemsSince('2000-01-01').length, items.length);
});

test('runRadar: --once makes one pass; --for limits the number of passes', async () => {
  const store = openStore(':memory:');
  const loader = async () => [item('a', 1)];
  const logPath = join(tmp(), 'e.log');
  let t = 0;
  const clock = () => t;
  const sleep = async (ms) => { t += ms; };
  assert.equal(await runRadar({ sources: [{ id: 'a' }], store, loader, logPath, once: true, clock, sleep }), 1);
  assert.equal(t, 0);
  // 300 s with a 120 s step: passes at 0, 120, 240 — the next one would exceed 300
  assert.equal(await runRadar({ sources: [{ id: 'a' }], store, loader, logPath, forSec: 300, clock, sleep }), 3);
});

test('parseArgs', () => {
  assert.deepEqual(parseArgs(['--once']), { once: true, forSec: null });
  assert.deepEqual(parseArgs(['--for', '90']), { once: false, forSec: 90 });
  assert.throws(() => parseArgs(['--for']));
  assert.throws(() => parseArgs(['--bogus']));
});
