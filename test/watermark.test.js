import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { runQueue } from '../src/publish.js';
import { imageSize, fitSize, watermarkModeOf, watermark, watermarkCached, watermarkHtml, extractJpeg, WatermarkError } from '../src/watermark.js';

const png = (w, h) => { const b = Buffer.alloc(64); b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
const jpg = (w, h) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8]), Buffer.from([h >> 8, h & 255, w >> 8, w & 255]), Buffer.alloc(30)]);
const fakeJpeg = (w, h) => Buffer.concat([jpg(w, h), Buffer.alloc(200, 1)]);
const domOf = (buf) => `<html><body><pre id="out">data:image/jpeg;base64,${buf.toString('base64')}</pre></body></html>`;

test('size: png, jpeg; fitSize keeps proportions and caps at 2048', () => {
  assert.deepEqual(imageSize(png(800, 600)), { width: 800, height: 600 });
  assert.deepEqual(imageSize(jpg(1200, 630)), { width: 1200, height: 630 });
  assert.equal(imageSize(Buffer.alloc(40)), null);
  assert.deepEqual(fitSize({ width: 1000, height: 500 }), { width: 1000, height: 500 });
  assert.deepEqual(fitSize({ width: 4096, height: 2048 }), { width: 2048, height: 1024 });
  assert.deepEqual(fitSize({ width: 1500, height: 3000 }), { width: 1024, height: 2048 });
});

test('mode: on by default; off only when set explicitly', () => {
  assert.equal(watermarkModeOf({}), 'on');
  assert.equal(watermarkModeOf(undefined), 'on');
  assert.equal(watermarkModeOf({ watermark: 'on' }), 'on');
  assert.equal(watermarkModeOf({ watermark: 'off' }), 'off');
});

test('html: diagonal present on photos, absent on cards; JPEG ≥ 0.88', () => {
  const photo = watermarkHtml({ dataUri: 'data:image/png;base64,AA', width: 100, height: 50, brand: 'AI NEWS STUDIO', diagonal: true });
  const card = watermarkHtml({ dataUri: 'data:image/png;base64,AA', width: 100, height: 50, brand: 'AI NEWS STUDIO', diagonal: false });
  assert.match(photo, /"diagonal":true/);
  assert.match(card, /"diagonal":false/);
  assert.match(photo, /"alpha":0\.09/);
  assert.ok(Number(/"q":([\d.]+)/.exec(photo)[1]) >= 0.88);
  assert.equal(extractJpeg('<pre id="out">ERROR</pre>'), null);
});

test('no browser — WatermarkError no-browser', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wmt-'));
  try {
    const f = join(dir, 'a.png'); await writeFile(f, png(10, 10));
    await assert.rejects(watermark(f, { outFile: join(dir, 'o.jpg'), browser: null }), (e) => e instanceof WatermarkError && e.code === 'no-browser');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('render: size unchanged, 4096 → 2048; a broken response — a render error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wmt-'));
  try {
    const f = join(dir, 'a.png'); await writeFile(f, png(900, 600));
    const exec = async (_exe, args) => {
      const m = /--window-size=(\d+),(\d+)/.exec(args.join(' '));
      return domOf(fakeJpeg(+m[1], +m[2]));
    };
    const r = await watermark(f, { outFile: join(dir, 'o.jpg'), browser: 'x', exec });
    assert.deepEqual([r.width, r.height], [900, 600]);
    assert.deepEqual(imageSize(await readFile(r.file)), { width: 900, height: 600 });
    const big = join(dir, 'b.png'); await writeFile(big, png(4096, 2048));
    const r2 = await watermark(big, { outFile: join(dir, 'o2.jpg'), browser: 'x', exec });
    assert.deepEqual([r2.width, r2.height], [2048, 1024]);
    await assert.rejects(watermark(f, { outFile: join(dir, 'o3.jpg'), browser: 'x', exec: async () => '<html></html>' }), (e) => e.code === 'render');
    await assert.rejects(watermark(f, { outFile: join(dir, 'o4.jpg'), browser: 'x', exec: async () => domOf(fakeJpeg(10, 10)) }), (e) => e.code === 'render');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cache: the second call does not render; card — a separate key without the diagonal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wmt-'));
  try {
    const f = join(dir, 'a.png'); await writeFile(f, png(300, 200));
    const htmls = [];
    const exec = async (_e, args) => { htmls.push(args); const m = /--window-size=(\d+),(\d+)/.exec(args.join(' ')); return domOf(fakeJpeg(+m[1], +m[2])); };
    const o = { browser: 'x', exec, dir: join(dir, 'wm') };
    const a = await watermarkCached(f, o);
    assert.equal(a.cached, false);
    const n = htmls.length;
    const b = await watermarkCached(f, o);
    assert.equal(b.cached, true);
    assert.equal(b.file, a.file);
    assert.equal(htmls.length, n);
    const c = await watermarkCached(f, { ...o, source: 'card' });
    assert.notEqual(c.file, a.file);
    assert.ok(existsSync(c.file));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ───── publishing ─────

const T0 = new Date('2026-10-30T10:00:00.000Z');
function queue(source = 'og') {
  const s = openStore(':memory:');
  s.upsert({ id: 'e1', title: 'Событие', firstSeen: T0.toISOString(), independentSources: 2, score: 70, reasons: [], needsOwner: false, sources: [{ source: 'x', name: 'X', link: 'https://example.com/1', published: T0.toISOString() }] }, T0.toISOString());
  s.addDraft({ eventId: 'e1', style: 'срочно', text: 'Текст поста', gateOk: true, reasons: [] }, '2026-10-30T09:00:00.000Z');
  s.ownerAct('d-e1', 'одобрил', {}, T0.toISOString());
  s.addImage({ draftId: 'd-e1', eventId: 'e1', file: 'data/images/orig.jpg', sha256: 'abc', url: 'u', source, license: 'own', author: 'a', width: 10, height: 10 });
  return s;
}
const okSend = () => { const calls = []; return { calls, send: async (r) => { calls.push(r); return { message_id: 7 }; } }; };

test('publishing: the photo goes out as a file with the mark, not the original; source is passed', async () => {
  const { send, calls } = okSend();
  const seen = [];
  const r = await runQueue({ store: queue('card'), chat: '@c', send, now: T0, mark: async (f, o) => { seen.push([f, o.source]); return { file: 'data/images/wm/x.jpg' }; } });
  assert.equal(r.published.length, 1);
  assert.equal(calls[0].method, 'sendPhoto');
  assert.equal(calls[0].params.photo, 'data/images/wm/x.jpg');
  assert.deepEqual(seen, [['data/images/orig.jpg', 'card']]);
});

test('publishing: a mark error — text without a picture, the original does not go out, the post is not deferred', async () => {
  const { send, calls } = okSend();
  const r = await runQueue({ store: queue(), chat: '@c', send, now: T0, mark: async () => { throw new WatermarkError('no-browser', 'no browser'); } });
  assert.equal(r.published.length, 1);
  assert.equal(calls[0].method, 'sendMessage');
  assert.ok(!JSON.stringify(calls[0]).includes('orig.jpg'));
  assert.match(r.warnings[0].reason, /no browser/);
});

test('publishing: watermark off — the original, without calling the mark', async () => {
  const { send, calls } = okSend();
  const r = await runQueue({ store: queue(), chat: '@c', send, now: T0, config: { watermark: 'off' }, mark: async () => { throw new Error('не должен вызываться'); } });
  assert.equal(r.published.length, 1);
  assert.equal(calls[0].params.photo, 'data/images/orig.jpg');
});

test('publishing without a browser by default: the post goes out as text', async () => {
  const { send, calls } = okSend();
  const prev = process.env.CARD_BROWSER;
  process.env.CARD_BROWSER = join(tmpdir(), 'no-such-browser.exe');
  try {
    const r = await runQueue({ store: queue(), chat: '@c', send, now: T0 });
    assert.equal(r.published.length, 1);
    assert.equal(calls[0].method, 'sendMessage');
    assert.equal(r.warnings.length, 1);
  } finally { if (prev === undefined) delete process.env.CARD_BROWSER; else process.env.CARD_BROWSER = prev; }
});
