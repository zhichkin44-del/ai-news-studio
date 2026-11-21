import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFeed, parseMediaImage } from '../src/collect.js';
import { openStore } from '../src/store.js';
import { parseOgImage, parseCommons, checkLicense, keyNames, sniffImage, pickImage, attachImage as attachImageCard, attachPending as attachPendingCard, formatTable } from '../src/images.js';

// these tests cover photos; cards (card_mode) are checked by card.test.js
const OFF = { card_mode: 'off' };
const attachImage = (store, draft, o = {}) => attachImageCard(store, draft, { config: OFF, ...o });
const attachPending = (store, o = {}) => attachPendingCard(store, { config: OFF, ...o });

// minimal PNG 800×600 (the header is enough to parse the size)
const png = (w = 800, h = 600, tail = 'a') => {
  const b = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b.write(tail, 30);
  return b;
};
const imgRes = (buf, type = 'image/png') => new Response(buf, { headers: { 'content-type': type } });

test('feed media tags: content / thumbnail / enclosure, not video', () => {
  assert.equal(parseMediaImage('<media:content url="http://x/a.jpg" medium="image" width="100"/><media:content url="http://x/b.jpg" medium="image" width="600"/>'), 'http://x/b.jpg');
  assert.equal(parseMediaImage('<media:thumbnail url="http://x/t.jpg"/>'), 'http://x/t.jpg');
  assert.equal(parseMediaImage('<enclosure url="http://x/p.png?a=1&amp;b=2" type="image/png" length="1"/>'), 'http://x/p.png?a=1&b=2');
  assert.equal(parseMediaImage('<enclosure url="http://x/v.mp4" type="video/mp4"/><media:content url="http://x/v.mp4" medium="video"/>'), null);
  const items = parseFeed('<rss><channel><item><title>T</title><link>http://x/1</link><media:thumbnail url="http://x/t.jpg"/></item></channel></rss>', { id: 's' });
  assert.equal(items[0].image, 'http://x/t.jpg');
});

test('og:image: relative link, attributes in any order', () => {
  assert.equal(parseOgImage('<head><meta content="/img/o.jpg" property="og:image"></head>', 'https://site.ru/news/1'), 'https://site.ru/img/o.jpg');
  assert.equal(parseOgImage('<meta name="twitter:image" content="https://c/t.jpg">', 'https://a/'), 'https://c/t.jpg');
  assert.equal(parseOgImage('<meta property="og:title" content="x">', 'https://a/'), null);
});

test('licenses: open ones pass; NC/ND/GFDL and CC BY without an author do not', () => {
  assert.equal(checkLicense('CC0', null).ok, true);
  assert.equal(checkLicense('Public domain', null).ok, true);
  assert.equal(checkLicense('CC BY-SA 4.0', 'Иван').ok, true);
  assert.equal(checkLicense('CC BY 2.0', 'Иван').ok, true);
  assert.equal(checkLicense('CC BY 2.0', null).ok, false);
  assert.equal(checkLicense('CC BY-NC 4.0', 'a').ok, false);
  assert.equal(checkLicense('CC BY-ND 4.0', 'a').ok, false);
  assert.equal(checkLicense('GFDL', 'a').ok, false);
  assert.equal(checkLicense('', 'a').ok, false);
});

const commonsJson = {
  query: { pages: {
    1: { index: 1, title: 'File:A.jpg', imageinfo: [{ url: 'https://u/a.jpg', thumburl: 'https://u/a-1280.jpg', thumbwidth: 1280, thumbheight: 853, width: 4000, height: 2667, mime: 'image/jpeg', extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' }, Artist: { value: '<a href="x">Анна Петрова</a>' } } }] },
    2: { index: 2, title: 'File:B.jpg', imageinfo: [{ url: 'https://u/b.jpg', width: 3000, height: 2000, mime: 'image/jpeg', extmetadata: { LicenseShortName: { value: 'CC BY-NC 2.0' }, Artist: { value: 'X' } } }] },
    3: { index: 3, title: 'File:C.svg', imageinfo: [{ url: 'https://u/c.svg', width: 3000, height: 2000, mime: 'image/svg+xml', extmetadata: { LicenseShortName: { value: 'CC0' } } }] },
    4: { index: 4, title: 'File:D.jpg', imageinfo: [{ url: 'https://u/d.jpg', width: 300, height: 200, mime: 'image/jpeg', extmetadata: { LicenseShortName: { value: 'CC0' } } }] },
    5: { index: 5, title: 'File:E.jpg', imageinfo: [{ url: 'https://u/e.jpg', width: 2000, height: 1000, mime: 'image/jpeg', extmetadata: { LicenseShortName: { value: 'Public domain' } } }] },
  } },
};

test('Commons response: open license + author, size, format', () => {
  const r = parseCommons(commonsJson);
  assert.deepEqual(r.map((x) => x.title), ['File:A.jpg', 'File:E.jpg']);
  assert.equal(r[0].author, 'Анна Петрова');
  assert.equal(r[0].license, 'CC BY-SA 4.0');
  assert.equal(r[0].url, 'https://u/a-1280.jpg');
  assert.equal(r[0].width, 1280);
});

test('key names from the headline', () => {
  assert.deepEqual(keyNames('Президент Франции Макрон прибыл в Берлин на переговоры'), ['Франции Макрон', 'Берлин']);
  assert.deepEqual(keyNames('в городе прошёл митинг'), []);
  assert.deepEqual(keyNames('Макрон прибыл в город'), ['Макрон']); // a name at the start of the headline
});

test('time budget exhausted — no network calls; the draft stays without a picture', async () => {
  const store = setup();
  let calls = 0;
  const f = async () => { calls++; throw new Error('сети нет'); };
  assert.equal(await attachImage(store, store.getDraft('d-e1'), { fetchImpl: f, budgetMs: -1, dir: tmpdir() }), null);
  assert.equal(calls, 0);
});

test('PNG and JPEG size from the header', () => {
  assert.deepEqual(sniffImage(png(1024, 768)), { ext: 'png', width: 1024, height: 768 });
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(sniffImage(jpg), { ext: 'jpg', width: 640, height: 480 });
  assert.equal(sniffImage(Buffer.from('<html>')), null);
});

test('pickImage: feed → og → Commons', async () => {
  const f = async (u) => {
    const s = String(u);
    if (s.includes('commons.wikimedia.org')) return Response.json(commonsJson);
    if (s === 'https://art/1') return new Response('<head><meta property="og:image" content="https://og/i.jpg"></head>');
    throw new Error('сети нет');
  };
  const ev = { title: 'Макрон прибыл в Берлин', links: ['https://art/1'], images: [] };
  assert.equal((await pickImage({ ...ev, images: ['https://feed/i.jpg'] }, { fetchImpl: f })).source, 'feed');
  assert.equal((await pickImage(ev, { fetchImpl: f })).source, 'og');
  const c = await pickImage({ ...ev, links: ['https://dead/'] }, { fetchImpl: f });
  assert.deepEqual([c.source, c.license, c.author], ['commons', 'CC BY-SA 4.0', 'Анна Петрова']);
  assert.equal(await pickImage({ title: 'нет имён тут', links: [], images: [] }, { fetchImpl: f }), null);
});

function setup() {
  const store = openStore(':memory:');
  for (const n of ['1', '2']) {
    store.addItems([{ id: `s:${n}`, source: 's', title: `Событие ${n}`, link: `https://art/${n}`, published: '2026-10-28T10:00:00Z', image: `https://feed/${n}.png` }]);
    store.upsert({ id: `e${n}`, title: `Событие ${n}`, independentSources: 2, score: 80, sources: [{ source: 's', link: `https://art/${n}`, published: '2026-10-28T10:00:00Z' }] });
    store.addDraft({ eventId: `e${n}`, style: 'x', text: 'Текст', gateOk: true });
  }
  return store;
}

test('attachImage: downloads, writes to images; a repeat creates no duplicates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'img-'));
  const store = setup();
  let calls = 0;
  const f = async (u) => { calls++; return imgRes(png(800, 600, String(u).slice(-5))); };
  const d = store.getDraft('d-e1');
  const r = await attachImage(store, d, { fetchImpl: f, dir });
  assert.equal(r.source, 'feed');
  assert.deepEqual([r.width, r.height], [800, 600]);
  assert.equal((await readdir(dir)).length, 1);
  assert.match(r.file, /[0-9a-f]{64}\.png$/);
  const n = calls;
  await attachImage(store, d, { fetchImpl: f, dir });
  assert.equal(calls, n); // a repeat does not hit the network
  assert.equal((await readdir(dir)).length, 1);
  assert.equal(store.eventMedia('e1')[0].image, 'https://feed/1.png');
});

test('a duplicate by sha256 and by URL is skipped; a non-picture and >5 MB are rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'img-'));
  const store = setup();
  const same = png(800, 600, 'same');
  const f = async () => imgRes(same);
  assert.ok(await attachImage(store, store.getDraft('d-e1'), { fetchImpl: f, dir }));
  // the second draft has the same bytes under another URL → a sha256 duplicate, no other candidates
  assert.equal(await attachImage(store, store.getDraft('d-e2'), { fetchImpl: async (u) => (String(u).includes('art/') ? new Response('') : imgRes(same)), dir }), null);
  // the same URL is already taken
  store.addItems([{ id: 's:3', source: 's', title: 'x', link: 'https://art/2', image: 'https://feed/1.png' }]);
  assert.equal(await attachImage(store, store.getDraft('d-e2'), { fetchImpl: async () => new Response('<html>', { headers: { 'content-type': 'text/html' } }), dir }), null);
  const big = Buffer.concat([png(), Buffer.alloc(5 * 1024 * 1024)]);
  assert.equal(await attachImage(store, store.getDraft('d-e2'), { fetchImpl: async () => imgRes(big), dir }), null);
});

test('attachPending: table without links; one error does not stop the others', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'img-'));
  const store = setup();
  const f = async (u) => {
    if (String(u).includes('feed/2')) throw new Error('boom');
    return imgRes(png(800, 600, String(u).slice(-5)));
  };
  const rows = await attachPending(store, { fetchImpl: f, dir });
  assert.equal(rows.filter((r) => r.image).length, 1);
  const t = formatTable(rows);
  assert.match(t, /d-e1 — feed — 800×600 — —/);
  assert.match(t, /d-e2 — нет картинки/);
  assert.ok(!t.includes('http'));
});
