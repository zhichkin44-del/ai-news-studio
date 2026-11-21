import { readFile } from 'node:fs/promises';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decode(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

function clean(s) {
  if (s == null) return '';
  const noCdata = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, x) => x);
  // entities → strip tags → entities inside the HTML description
  return decode(decode(noCdata).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : null;
}

function atomLink(block) {
  const links = [...block.matchAll(/<link\b([^>]*?)\/?>/gi)].map((m) => m[1]);
  const pick = links.find((a) => /rel=["']alternate["']/.test(a)) ?? links.find((a) => !/rel=/.test(a)) ?? links[0];
  const h = pick?.match(/href=["']([^"']+)["']/);
  return h ? decode(h[1]) : '';
}

function toIso(s) {
  const t = Date.parse(s ?? '');
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Record image: media:content / media:thumbnail / enclosure type=image (not video or audio). */
export function parseMediaImage(block) {
  const attr = (a, n) => a.match(new RegExp(`(?:^|\\s)${n}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'))?.slice(1).find(Boolean);
  const cands = [];
  for (const m of block.matchAll(/<(media:content|media:thumbnail|enclosure)(\s[^>]*)?>/gi)) {
    const [, name, a = ''] = m;
    const url = attr(a, 'url');
    if (!url) continue;
    const type = (attr(a, 'type') ?? '').toLowerCase();
    const medium = (attr(a, 'medium') ?? '').toLowerCase();
    const isThumb = name.toLowerCase() === 'media:thumbnail';
    const ok = type ? type.startsWith('image/') : medium ? medium === 'image' : isThumb || /\.(jpe?g|png|webp)(\?|$)/i.test(url);
    if (ok && /^https?:\/\//i.test(decode(url))) cands.push({ url: decode(url), w: Number(attr(a, 'width')) || 0, rank: isThumb ? 0 : 1 });
  }
  cands.sort((x, y) => y.w - x.w || y.rank - x.rank);
  return cands[0]?.url ?? null;
}

/** USGS GeoJSON (earthquakes): one record per event; source.min_mag filters out weak tremors. */
export function parseGeoJson(text, source) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const out = [];
  for (const f of data?.features ?? []) {
    const p = f?.properties ?? {};
    const mag = Number(p.mag);
    const link = p.url ?? '';
    if (!Number.isFinite(mag) || !link || mag < (source.min_mag ?? 0)) continue;
    const place = String(p.place ?? '').trim();
    const published = Number.isFinite(Number(p.time)) ? new Date(Number(p.time)).toISOString() : null;
    const depth = Array.isArray(f.geometry?.coordinates) ? Number(f.geometry.coordinates[2]) : NaN;
    const summary = [
      `Earthquake magnitude ${mag.toFixed(1)}${place ? `, ${place}` : ''}.`,
      Number.isFinite(depth) && `Depth ${Math.round(depth)} km.`,
      p.tsunami === 1 && 'Tsunami warning issued.',
      p.alert && `USGS alert level: ${p.alert}.`,
    ].filter(Boolean).join(' ');
    out.push({ id: `${source.id}:${f.id ?? link}`, title: p.title ? clean(p.title) : `M ${mag.toFixed(1)} - ${place}`, summary, link, source: source.id, published, image: null });
  }
  return out;
}

/** Parses RSS 2.0 / Atom (or GeoJSON, if the feed serves JSON) into normalized records. */
export function parseFeed(xml, source) {
  if (source.format === 'geojson' || xml.trimStart().startsWith('{')) return parseGeoJson(xml, source);
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const re = isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi;
  const out = [];
  for (const block of xml.match(re) ?? []) {
    const title = clean(tag(block, 'title'));
    const link = isAtom ? atomLink(block) : clean(tag(block, 'link'));
    if (!title || !link) continue;
    const summary = clean(tag(block, isAtom ? 'summary' : 'description') ?? tag(block, 'content'));
    const published = toIso(clean(tag(block, isAtom ? 'published' : 'pubDate') ?? tag(block, 'updated') ?? tag(block, 'dc:date')));
    const id = clean(tag(block, isAtom ? 'id' : 'guid')) || link;
    out.push({ id: `${source.id}:${id}`, title, summary, link, source: source.id, published, image: parseMediaImage(block) });
  }
  return out;
}

/** Feed bytes to a string: charset from the header or the XML declaration (Gazeta.ru — windows-1251/cp1251). */
export function decodeBuffer(buf, contentType = '') {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1];
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 256));
  const charset = (fromHeader ?? /encoding\s*=\s*["']([\w-]+)/i.exec(head)?.[1] ?? 'utf-8').toLowerCase();
  if (charset === 'utf-8' || charset === 'utf8') return new TextDecoder('utf-8').decode(bytes);
  const label = charset === 'cp1251' ? 'windows-1251' : charset;
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export async function fetchFeed(source, { timeoutMs = 15000, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(source.url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'studio-news/0.1' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (typeof res.arrayBuffer === 'function') {
    const buf = new Uint8Array(await res.arrayBuffer());
    return parseFeed(decodeBuffer(buf, res.headers?.get?.('content-type') ?? ''), source);
  }
  return parseFeed(await res.text(), source);
}

/** Collects all feeds; an error in one feed goes into errors and does not break the collection. */
export async function collect(sources, { loader = fetchFeed } = {}) {
  const results = await Promise.allSettled(sources.map((s) => loader(s)));
  const items = [];
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push(...r.value);
    else errors.push({ source: sources[i].id, error: String(r.reason?.message ?? r.reason) });
  });
  return { items, errors };
}

export async function loadSources(path = new URL('../sources.json', import.meta.url)) {
  return JSON.parse(await readFile(path, 'utf8')).sources;
}
