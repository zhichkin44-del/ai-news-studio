import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { selectEvents } from '../src/select-run.js';

const NOW = new Date('2026-10-28T12:00:00.000Z');
const rec = (id, source, title, published, link = `https://example.com/${id}`) => ({ id, source, title, summary: 'Кратко', link, published });

function fixture() {
  const s = openStore(join(mkdtempSync(join(tmpdir(), 'sel-')), 'news.db'));
  const at = (iso) => ({ now: iso, baseline: false });
  s.addItems([
    rec('a1', 'bbc', 'Землетрясение магнитудой 7 произошло у берегов Японии, есть погибшие', '2026-10-28T11:30:00Z'),
    rec('a2', 'reuters', 'Землетрясение магнитудой 7 у берегов Японии: есть погибшие', '2026-10-28T11:40:00Z'),
    rec('b1', 'tass', 'Мэр открыл новую скамейку в городском парке', '2026-10-28T11:00:00Z'),
  ], at('2026-10-28T11:50:00.000Z'));
  s.addItems([rec('old', 'bbc', 'Древняя новость о прошлом годе', '2026-10-20T11:00:00Z')], at('2026-10-20T11:00:00.000Z'));
  return s;
}

test('select: окно по часам, итог, статусы', () => {
  const s = fixture();
  const r = selectEvents(s, { hours: 24, now: NOW });
  assert.equal(r.items, 3); // старая запись вне окна
  assert.equal(r.events, 2);
  const all = s.list();
  const quake = all.find((e) => e.title.includes('Землетрясение'));
  assert.equal(quake.status, 'отобрано');
  assert.equal(quake.independent_sources, 2);
  const bench = all.find((e) => e.title.includes('скамейку'));
  assert.notEqual(bench.status, 'отобрано');
  assert.ok(bench.status_reason);
  assert.equal(r.selected + r.rejected + r.fresh, r.events);
  s.close();
});

test('select: идемпотентен, дублей нет', () => {
  const s = fixture();
  selectEvents(s, { hours: 24, now: NOW });
  const before = s.list().map((e) => [e.id, e.status, e.score]);
  const r2 = selectEvents(s, { hours: 24, now: NOW });
  assert.equal(s.count(), 2);
  assert.deepEqual(s.list().map((e) => [e.id, e.status, e.score]), before);
  assert.equal(r2.events, 2);
  s.close();
});

test('select: выпущенное и с черновиком статус не сбрасывает', () => {
  const s = fixture();
  selectEvents(s, { hours: 24, now: NOW });
  const [q, b] = [s.list().find((e) => e.title.includes('Землетрясение')), s.list().find((e) => e.title.includes('скамейку'))];
  s.setStatus(q.id, 'выпущено', 'ручной');
  s.addDraft({ eventId: b.id, text: 'Текст', gateOk: true });
  s.setStatus(b.id, 'отобрано', 'вручную');
  selectEvents(s, { hours: 24, now: NOW });
  assert.equal(s.get(q.id).status, 'выпущено');
  assert.equal(s.get(b.id).status, 'отобрано');
  assert.equal(s.count(), 2);
  s.close();
});

test('select: окно --hours сужается', () => {
  const s = fixture();
  const r = selectEvents(s, { hours: 0.1, now: NOW });
  assert.equal(r.items, 0);
  assert.equal(r.events, 0);
  s.close();
});
