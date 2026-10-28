import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smoke, formatSmoke } from '../src/smoke.js';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const mk = (source, minAgo) => ({ id: `${source}:1`, title: 't', link: 'l', source, published: new Date(NOW - minAgo * 60000).toISOString() });
const SRC = [{ id: 'a' }, { id: 'b' }];

test('все ленты свежие — ok', async () => {
  const r = await smoke(SRC, { now: NOW, loader: async (s) => [mk(s.id, 30), mk(s.id, 500)] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.rows.map((x) => [x.source, x.count, x.ageMin]), [['a', 2, 30], ['b', 2, 30]]);
  assert.match(formatSmoke(r), /a \| 2 \| 2026-10-28T11:30:00.000Z \| 30 мин/);
});

test('ошибка ленты — не ok, остальные в таблице', async () => {
  const r = await smoke(SRC, { now: NOW, loader: async (s) => { if (s.id === 'b') throw new Error('HTTP 404'); return [mk('a', 5)]; } });
  assert.equal(r.ok, false);
  assert.match(formatSmoke(r), /b \| 0 \| — \| ОШИБКА: HTTP 404/);
});

test('нет записей младше 6 часов или пусто — не ok', async () => {
  const old = await smoke([{ id: 'a' }], { now: NOW, loader: async () => [mk('a', 400)] });
  assert.equal(old.ok, false);
  assert.match(formatSmoke(old), /нет записей младше 6 ч/);
  const empty = await smoke([{ id: 'a' }], { now: NOW, loader: async () => [] });
  assert.equal(empty.ok, false);
});
