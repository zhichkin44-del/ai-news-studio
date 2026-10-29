import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode } from './collect.js';
import { openStore } from './store.js';
import { DEFAULT_CONFIG } from './score.js';
import { renderCard, cardModeOf, brandOf } from './card.js';

export const IMAGES_DIR = process.env.NEWS_IMAGES_DIR || 'data/images';
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PAGE_BYTES = 300 * 1024;
export const PAGE_TIMEOUT_MS = 8000;
const UA = { 'user-agent': 'studio-news/0.1 (image picker)' };
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const MIN_WIDTH = 600;

/** Читает тело потока не больше max байт; возвращает { buf, truncated }. */
async function readLimited(res, max) {
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { buf: buf.subarray(0, max), truncated: buf.length > max };
  }
  const parts = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of res.body) {
    parts.push(chunk);
    size += chunk.length;
    if (size > max) { truncated = true; break; }
  }
  try { await res.body.cancel?.(); } catch { /* уже закрыт */ }
  return { buf: Buffer.concat(parts).subarray(0, max), truncated };
}

/** og:image / twitter:image из HTML (достаточно головы страницы). */
export function parseOgImage(html, base) {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const t = m[0];
    const key = t.match(/\b(?:property|name)=["']([^"']+)["']/i)?.[1]?.toLowerCase();
    if (key !== 'og:image' && key !== 'og:image:url' && key !== 'og:image:secure_url' && key !== 'twitter:image') continue;
    const content = t.match(/\bcontent=["']([^"']+)["']/i)?.[1];
    if (!content) continue;
    try {
      const u = new URL(decode(content), base);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
    } catch { /* битая ссылка */ }
  }
  return null;
}

/** Только голова страницы: таймаут 8 с, до 300 КБ. */
export async function fetchOgImage(pageUrl, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(pageUrl, { signal: AbortSignal.timeout(PAGE_TIMEOUT_MS), headers: { ...UA, accept: 'text/html' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { buf } = await readLimited(res, MAX_PAGE_BYTES);
  const html = buf.toString('utf8');
  const head = html.search(/<\/head>/i);
  return parseOgImage(head > 0 ? html.slice(0, head) : html, res.url || pageUrl);
}

const stripTags = (s) => decode(String(s ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/**
 * Лицензия Commons → { ok, license }. Разрешены CC0, общественное достояние, CC BY, CC BY-SA;
 * NC, ND, GFDL-only, «fair use» и неизвестное — нет. Для CC BY / BY-SA автор обязателен.
 */
export function checkLicense(short, author) {
  const s = stripTags(short);
  if (!s) return { ok: false, license: null };
  if (/\b(nc|nd)\b|non-?commercial|no-?deriv|fair use|gfdl|copyrighted/i.test(s)) return { ok: false, license: s };
  if (/^(cc0|cc[- ]zero|public domain|pd\b|pdm)/i.test(s)) return { ok: true, license: s };
  if (/^cc[- ]by(?:[- ]sa)?\b/i.test(s)) return { ok: !!author, license: s };
  return { ok: false, license: s };
}

/** Ответ Commons (generator=search + imageinfo) → кандидаты с открытой лицензией и автором. */
export function parseCommons(json) {
  const out = [];
  const pages = Object.values(json?.query?.pages ?? {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  for (const p of pages) {
    const ii = p.imageinfo?.[0];
    if (!ii) continue;
    if (!/^image\/(jpeg|png|webp)$/i.test(ii.mime ?? '')) continue;
    const md = ii.extmetadata ?? {};
    const author = stripTags(md.Artist?.value) || null;
    const lic = checkLicense(md.LicenseShortName?.value, author);
    if (!lic.ok) continue;
    const url = ii.thumburl || ii.url;
    const width = ii.thumbwidth || ii.width;
    if (!url || !(width >= MIN_WIDTH)) continue;
    out.push({ url, source: 'commons', license: lic.license, author, width, height: ii.thumbheight || ii.height || null, title: p.title });
  }
  return out;
}

/** Ключевые имена/места из заголовка: последовательности слов с заглавной буквы (не считая первого слова фразы). */
export function keyNames(title) {
  const words = String(title ?? '').split(/\s+/).map((w) => w.replace(/^[«"'(]+|[»"'),.:;!?—-]+$/g, ''));
  const found = [];
  let cur = [];
  const flush = () => { if (cur.length) found.push(cur.join(' ')); cur = []; };
  words.forEach((w, i) => {
    if (i > 0 && /^[A-ZА-ЯЁ][\p{L}-]{2,}$/u.test(w)) cur.push(w);
    else flush();
  });
  flush();
  const first = words[0] ?? '';
  if (!found.length && /^[A-ZА-ЯЁ][\p{L}-]{3,}$/u.test(first)) found.push(first); // заголовок начинается с имени
  return found.sort((a, b) => b.length - a.length).slice(0, 2);
}

export async function searchCommons(query, { fetchImpl = fetch } = {}) {
  const u = new URL(COMMONS_API);
  const q = { action: 'query', format: 'json', generator: 'search', gsrnamespace: '6', gsrsearch: `${query} filetype:bitmap`, gsrlimit: '10', prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '1280' };
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  const res = await fetchImpl(u, { signal: AbortSignal.timeout(PAGE_TIMEOUT_MS), headers: UA });
  if (!res.ok) throw new Error(`Commons HTTP ${res.status}`);
  return parseCommons(await res.json());
}

/**
 * Кандидаты по приоритету: лента → og:image → Commons. Ошибка одного источника не мешает следующим.
 * event: { title, links: [], images: [] }; skipUrl(url) → true, если картинка с этим URL уже занята.
 */
export async function* candidates(event, { fetchImpl = fetch, skipUrl = () => false, deadline = Infinity } = {}) {
  const late = () => Date.now() > deadline; // общий бюджет времени на один черновик
  const seen = new Set();
  const fresh = (url) => url && !seen.has(url) && !skipUrl(url) && (seen.add(url), true);
  const blank = { license: null, author: null, width: null, height: null };
  for (const url of event.images ?? []) if (fresh(url)) yield { url, source: 'feed', ...blank };
  for (const link of (event.links ?? []).slice(0, 3)) {
    if (late()) return;
    let url = null;
    try { url = await fetchOgImage(link, { fetchImpl }); } catch { /* страница недоступна — дальше */ }
    if (fresh(url)) yield { url, source: 'og', ...blank };
  }
  for (const name of keyNames(event.title)) {
    if (late()) return;
    let list = [];
    try { list = await searchCommons(name, { fetchImpl }); } catch { /* Commons недоступен */ }
    for (const c of list) if (fresh(c.url)) yield c;
  }
}

/** Лучший кандидат или null. */
export async function pickImage(event, opts = {}) {
  for await (const c of candidates(event, opts)) {
    const { title, ...rest } = c; // eslint-disable-line no-unused-vars
    return rest;
  }
  return null;
}

/** Размер по заголовку файла: JPEG, PNG, WebP, GIF. null — формат не распознан. */
export function sniffImage(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { ext: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { ext: 'jpg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return { ext: 'jpg', width: null, height: null };
  }
  if (buf.length > 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const k = buf.toString('latin1', 12, 16);
    if (k === 'VP8X') return { ext: 'webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (k === 'VP8L') { const b = buf.readUInt32LE(21); return { ext: 'webp', width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) }; }
    if (k === 'VP8 ') return { ext: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    return { ext: 'webp', width: null, height: null };
  }
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'GIF') return null; // GIF не поддерживаем (в том числе анимацию): формат не распознан → кандидат отвергается
  return null;
}

/** Скачать картинку в память: Content-Type image/*, не больше 5 МБ. Возвращает { buf, sha256, ext, width, height }. */
export async function downloadImage(url, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(20000), headers: { ...UA, accept: 'image/*' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!/^image\//i.test(res.headers.get('content-type') ?? '')) throw new Error('не image/*');
  const { buf, truncated } = await readLimited(res, MAX_IMAGE_BYTES);
  if (truncated) throw new Error('больше 5 МБ');
  const info = sniffImage(buf);
  if (!info) throw new Error('формат не распознан');
  return { buf, sha256: createHash('sha256').update(buf).digest('hex'), ...info };
}

/** Событие для подбора: заголовок, ссылки и картинки лент из базы. */
export function eventForPick(store, eventId) {
  const e = store.get(eventId);
  const media = store.eventMedia(eventId);
  return { title: e?.title ?? '', links: media.map((m) => m.link), images: media.map((m) => m.image).filter(Boolean) };
}

/**
 * Подобрать и скачать картинку черновику. Повтор — no-op. Дубль по URL или sha256 содержимого
 * пропускается, берётся следующий кандидат. Возвращает строку images или null.
 */
export async function attachImage(store, draft, { fetchImpl = fetch, dir = IMAGES_DIR, budgetMs = 45000, config = DEFAULT_CONFIG, render = renderCard } = {}) {
  const deadline = Date.now() + budgetMs;
  const have = store.getImage(draft.id);
  if (have) return have;
  const mode = cardModeOf(config);
  const card = async () => {
    const r = await render({ text: draft.text, category: store.get(draft.event_id)?.category ?? null, time: draft.created_at }, { outFile: join(dir, `card-${draft.id}.png`), config });
    store.addImage({ draftId: draft.id, eventId: draft.event_id, file: r.file, sha256: r.sha256, url: `card:${draft.id}`, source: 'card', license: 'own', author: brandOf(config), width: r.width, height: r.height });
    return store.getImage(draft.id);
  };
  if (mode === 'always') return card();
  const photo = await attachPhoto(store, draft, { fetchImpl, dir, deadline });
  if (photo || mode === 'off') return photo;
  return card();
}

async function attachPhoto(store, draft, { fetchImpl, dir, deadline }) {
  const event = eventForPick(store, draft.event_id);
  for await (const c of candidates(event, { fetchImpl, deadline, skipUrl: (u) => !!store.imageByUrl(u) })) {
    if (Date.now() > deadline) break;
    let dl;
    try { dl = await downloadImage(c.url, { fetchImpl }); } catch { continue; }
    if (store.imageBySha(dl.sha256)) continue;
    const file = join(dir, `${dl.sha256}.${dl.ext}`);
    await mkdir(dir, { recursive: true });
    await writeFile(file, dl.buf);
    store.addImage({ draftId: draft.id, eventId: draft.event_id, file, sha256: dl.sha256, url: c.url, source: c.source, license: c.license, author: c.author, width: dl.width ?? c.width, height: dl.height ?? c.height });
    return store.getImage(draft.id);
  }
  return null;
}

/** Черновикам «ждёт одобрения» без картинки — подбор. Ошибка одного не мешает остальным. */
export async function attachPending(store, opts = {}) {
  const rows = [];
  for (const d of store.listDrafts({ status: 'ждёт одобрения' })) {
    const had = !!store.getImage(d.id);
    let img = null;
    let error = null;
    try { img = await attachImage(store, d, opts); } catch (e) { error = e.message; }
    rows.push({ draft: d.id, image: img, new: !had && !!img, error });
  }
  return rows;
}

export function formatTable(rows) {
  return rows
    .map((r) => {
      const i = r.image;
      const size = i?.width ? `${i.width}×${i.height}` : '—';
      return `${r.draft} — ${i ? i.source : 'нет картинки'} — ${i ? size : '—'} — ${i?.license ?? '—'}${r.error ? ` (ошибка: ${r.error})` : ''}`;
    })
    .join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const store = openStore(process.env.NEWS_DB);
  const rows = await attachPending(store);
  store.close();
  console.log(rows.length ? formatTable(rows) : 'пусто');
}
