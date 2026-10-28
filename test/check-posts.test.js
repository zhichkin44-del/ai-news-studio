import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPosts } from '../src/check-posts.js';
import { toEvalEvents, stripLinks } from '../src/export-eval.js';

const good = { id: 'a1', style: 'сухо', text: 'В Испании столкнулись два поезда, погибли не менее 30 человек.' };
const bad = { id: 'a2', style: 'сухо', text: 'Подробности: https://example.com/news/1' };

test('checkPosts: хороший ok, плохой не ok с причиной', () => {
  const { rows, ok } = checkPosts([good, bad]);
  assert.equal(ok, false);
  assert.equal(rows[0].ok, true);
  assert.equal(rows[1].ok, false);
  assert.match(rows[1].reasons.join(), /ссылка/);
});

test('check-posts CLI: код 0 для хорошего, 1 для плохого', () => {
  const dir = mkdtempSync(join(tmpdir(), 'posts-'));
  const run = (posts) => {
    const f = join(dir, 'p.json');
    writeFileSync(f, JSON.stringify(posts));
    return spawnSync(process.execPath, ['src/check-posts.js', f], { encoding: 'utf8' });
  };
  const r0 = run([good]);
  assert.equal(r0.status, 0);
  assert.match(r0.stdout, /a1 — ok/);
  const r1 = run([good, bad]);
  assert.equal(r1.status, 1);
  assert.match(r1.stdout, /a2 — не ok/);
});

test('toEvalEvents: без ссылок и названий лент', () => {
  const ev = [{ id: 'x', title: 'T https://a.b/c', independent_sources: 2, score: 50, status: 'отобрано', reasons: ['r'], sources: [{ source: 'bbc', name: 'BBC', link: 'https://l/1' }] }];
  const out = toEvalEvents(ev, [{ link: 'https://l/1', summary: 'Текст https://l/1 конец' }]);
  assert.deepEqual(out[0], { id: 'x', title: 'T', summary: 'Текст конец', independent: 2, score: 50, status: 'отобрано', reasons: ['r'] });
  assert.equal(stripLinks('a www.x.com b'), 'a b');
});
