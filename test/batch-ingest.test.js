import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { pickEvents, makeBatch } from '../src/batch.js';
import { ingestPosts } from '../src/ingest.js';
import { pendingDrafts } from '../src/drafts.js';

const NOW = '2026-10-28T10:00:00.000Z';
const ev = (id, o = {}) => ({
  id, title: `Событие ${id}`, firstSeen: NOW, independentSources: 2, score: 60, reasons: ['r'], needsOwner: false,
  sources: [{ source: 'bbc', name: 'BBC', link: `https://example.com/${id}`, published: NOW }], ...o,
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'batch-'));
  const dbPath = join(dir, 'news.db');
  const s = openStore(dbPath);
  s.addItems([{ id: 'i1', source: 'bbc', title: 't', summary: 'Кратко https://x.com/a про A', link: 'https://example.com/a' }]);
  const put = (e, status = 'отобрано') => { s.upsert(e, NOW); s.setStatus(e.id, status, null, NOW); };
  put(ev('a', { score: 80 }));
  put(ev('b', { score: 50 }));
  put(ev('c', { independentSources: 1, score: 75, needsOwner: true })); // single-source, needs the owner
  put(ev('d', { independentSources: 1, score: 75 })); // single-source, allowed
  put(ev('e', { independentSources: 1, score: 60 })); // single-source, weak
  put(ev('f'), 'новое'); // not selected
  return { dir, dbPath, s };
}

test('pickEvents: selection rules, limit, no links', () => {
  const { s } = fixture();
  assert.deepEqual(pickEvents(s, 10).map((e) => e.id), ['a', 'd', 'b']);
  assert.deepEqual(pickEvents(s, 2).map((e) => e.id), ['a', 'd']);
  const a = pickEvents(s, 1)[0];
  assert.deepEqual(Object.keys(a), ['id', 'title', 'summary', 'independent', 'score', 'status', 'reasons']);
  assert.equal(a.summary, 'Кратко про A');
  assert.doesNotMatch(JSON.stringify(a), /http|BBC/i);
});

test('makeBatch: batch files; no events — null', async () => {
  const { dir, dbPath, s } = fixture();
  s.close();
  const folder = await makeBatch({ dbPath, max: 6, dir: join(dir, 'batches'), now: new Date('2026-10-28T10:00:00Z') });
  assert.ok(existsSync(join(folder, 'events.json')));
  assert.equal(JSON.parse(readFileSync(join(folder, 'events.json'), 'utf8')).length, 3);
  assert.ok(readFileSync(join(folder, 'README.md'), 'utf8').split('\n').length <= 10);
  const empty = openStore(join(dir, 'empty.db')); empty.close();
  assert.equal(await makeBatch({ dbPath: join(dir, 'empty.db'), dir: join(dir, 'b2') }), null);
});

test('ingest: gate, statuses, no duplicates; an event with a draft is not put into a batch', () => {
  const { s } = fixture();
  const r = ingestPosts(s, [
    { id: 'a', style: 'сухо', text: 'В городе открыли мост.' },
    { id: 'b', style: 'сухо', text: 'Подробности: https://example.com/b' },
    { id: 'zzz', style: 'сухо', text: 'текст' },
  ]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.rows.map((x) => x.ok), [true, false, false]);
  assert.match(r.rows[1].reasons.join(), /link/);
  assert.deepEqual(s.listDrafts().map((d) => [d.event_id, d.status, d.gate_ok]), [['a', 'ждёт одобрения', true], ['b', 'отклонён кодом', false]]);
  // repeat
  const again = ingestPosts(s, [{ id: 'a', style: 'иначе', text: 'Другой текст.' }]);
  assert.equal(again.ok, true);
  assert.equal(s.listDrafts().length, 2);
  assert.equal(s.listDrafts({ status: 'ждёт одобрения' })[0].text, 'В городе открыли мост.');
  // a corrected rejected draft is replaced
  ingestPosts(s, [{ id: 'b', style: 'сухо', text: 'Исправленный текст.' }]);
  assert.equal(s.listDrafts().length, 2);
  assert.equal(s.listDrafts({ status: 'ждёт одобрения' }).length, 2);
  assert.deepEqual(pickEvents(s, 10).map((e) => e.id), ['d']);
});

test('drafts: status change and output for the panel', () => {
  const { s } = fixture();
  ingestPosts(s, [{ id: 'a', style: 'сухо', text: 'Раз.' }, { id: 'b', style: 'тепло', text: 'Два.' }]);
  const [a] = pendingDrafts(s);
  assert.deepEqual(Object.keys(a), ['id', 'event_id', 'style', 'text', 'score']);
  assert.equal(a.score, 80);
  s.setDraftStatus(a.id, 'одобрен');
  assert.deepEqual(pendingDrafts(s).map((d) => d.event_id), ['b']);
  s.setDraftStatus(a.id, 'опубликован');
  assert.equal(s.listDrafts({ status: 'опубликован' }).length, 1);
  assert.throws(() => s.setDraftStatus(a.id, 'что-то'), /unknown/);
  assert.throws(() => s.setDraftStatus('нет', 'одобрен'), /no draft/);
});

test('CLI: batch → ingest → drafts --json', () => {
  const { dir, dbPath, s } = fixture();
  s.close();
  const env = { ...process.env, NEWS_DB: dbPath, NEWS_BATCHES: join(dir, 'batches') };
  const run = (...a) => spawnSync(process.execPath, a, { encoding: 'utf8', env });
  const b = run('src/batch.js', '--max', '2');
  assert.equal(b.status, 0);
  const folder = b.stdout.trim();
  const events = JSON.parse(readFileSync(join(folder, 'events.json'), 'utf8'));
  assert.equal(events.length, 2);
  writeFileSync(join(folder, 'posts.json'), JSON.stringify([
    { id: events[0].id, style: 'сухо', text: 'Хороший пост.' },
    { id: events[1].id, style: 'сухо', text: 'Плохой www.example.com пост.' },
  ]));
  const i = run('src/ingest.js', folder);
  assert.equal(i.status, 1);
  assert.match(i.stdout, /— ok/);
  assert.match(i.stdout, /— not ok — link/);
  const d = JSON.parse(run('src/drafts.js', '--json').stdout);
  assert.equal(d.length, 1);
  assert.equal(d[0].text, 'Хороший пост.');
  assert.equal(run('src/ingest.js', folder).status, 1); // the bad one stays bad, no duplicates
  assert.equal(JSON.parse(run('src/drafts.js', '--json').stdout).length, 1);
  // an event whose draft was rejected by code returns to the batch; one with a good draft does not
  const b2 = run('src/batch.js', '--max', '6');
  assert.equal(b2.status, 0);
  const ids = JSON.parse(readFileSync(join(b2.stdout.trim(), 'events.json'), 'utf8')).map((e) => e.id);
  assert.ok(!ids.includes(events[0].id));
  assert.ok(ids.includes(events[1].id));
});
