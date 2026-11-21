import { readFileSync } from 'node:fs';

const STOP = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'to', 'for', 'and', 'at', 'as', 'is', 'are', 'was', 'by', 'with', 'after', 'over', 'from', 'says', 'say', 'his', 'her', 'its', 'has', 'have', 'will', 'new', 'latest', 'live', 'what', 'how', 'why', 'amid', 'but', 'not', 'that', 'this',
  'и', 'в', 'во', 'на', 'с', 'со', 'по', 'за', 'к', 'о', 'об', 'от', 'до', 'из', 'для', 'не', 'что', 'как', 'при', 'у', 'а', 'но', 'или', 'это', 'его', 'ее', 'их', 'после', 'над', 'под', 'между', 'более', 'также', 'будет']);

const RU_ENDINGS = ['иями', 'ями', 'ами', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'ией', 'ает', 'яет', 'ают', 'яют', 'ила', 'ило', 'или', 'ить', 'ать', 'ять',
  'ия', 'ие', 'ию', 'ий', 'ой', 'ый', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие', 'ых', 'их', 'ом', 'ем', 'ам', 'ям', 'ах', 'ях', 'ов', 'ев', 'ей', 'ую', 'юю',
  'ла', 'ли', 'ет', 'ут', 'ют', 'ит', 'ат', 'ят', 'а', 'я', 'у', 'ю', 'ы', 'и', 'е', 'о', 'ь', 'й'];
const EN_ENDINGS = ['ing', 'ed', 'es', 's'];

const DIGEST = /^(главные новости дня|top stories|daily briefing)/i;
const WIN_MS = 12 * 3600e3;
const SUMMARY_CHARS = 200;
const L = '\\p{L}\\p{N}';

const isCyr = (w) => /\p{Script=Cyrillic}/u.test(w);
const norm = (s) => s.toLowerCase().replace(/ё/g, 'е');
const words = (s) => norm(s).match(/[\p{L}\p{N}]+/gu) ?? [];

/** Headline language by script: ru if there is more Cyrillic than Latin, otherwise en. */
export function langOf(title) {
  const cyr = (title.match(/\p{Script=Cyrillic}/gu) ?? []).length;
  const lat = (title.match(/\p{Script=Latin}/gu) ?? []).length;
  return cyr > lat ? 'ru' : 'en';
}

/** Rough word stem: strips endings (ru — a list, en — s/ed/ing), keeps at least 3 letters, at most 6. */
export function stem(w) {
  const ends = isCyr(w) ? RU_ENDINGS : EN_ENDINGS;
  if (!/\p{L}/u.test(w)) return w;
  for (const e of ends) if (w.length - e.length >= 3 && w.endsWith(e)) { w = w.slice(0, -e.length); break; }
  return w.slice(0, 6);
}

/** Compound NPR headline «Тема А. And, тема Б» ("Topic A. And, topic B") — only the first topic is the main one. */
const headline = (title) => title.split(/\.\s+And,?\s/)[0];

/** Headline words that start with a capital letter but are not first (proper nouns). */
function capitalized(title) {
  const raw = title.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
  return raw.slice(1).filter((w) => /^\p{Lu}/u.test(w) && w.replace(/['’-]/g, '').length >= 4);
}

/** Keys for within-language merging: stem → weight (numbers and proper nouns weigh 2). */
export function keys(title) {
  title = headline(title);
  const m = new Map();
  const put = (k, w) => m.set(k, Math.max(m.get(k) ?? 0, w));
  for (const w of words(title)) {
    if (STOP.has(w)) continue;
    if (/^\d+$/.test(w)) put(w, 2);
    else if (w.length > 2) put(stem(w), 1);
  }
  for (const w of capitalized(title)) for (const t of words(w)) if (t.length > 2 && !STOP.has(t)) put(stem(t), 2);
  return m;
}

/** Weighted Jaccard similarity between key sets. */
export function weightedSimilarity(a, b) {
  if (!a.size || !b.size) return 0;
  let common = 0, sa = 0, sb = 0;
  for (const w of a.values()) sa += w;
  for (const w of b.values()) sb += w;
  for (const [k, w] of a) if (b.has(k)) common += Math.max(w, b.get(k));
  return common / (sa + sb - common);
}

// ---------- anchors ----------

const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };

/** Consonant skeleton of a name: Cyrillic and Latin reduce to one key (Нетаньяху / Netanyahu → ntnh). */
export function skeleton(word) {
  let s = norm(word).replace(/[^\p{L}]/gu, '');
  s = [...s].map((c) => TRANSLIT[c] ?? c).join('');
  s = s.replace(/kh|ch/g, 'h').replace(/zh|sh/g, 's').replace(/z/g, 's').replace(/ts/g, 'c').replace(/[ck]/g, 'k').replace(/q/g, 'k').replace(/x/g, 'ks').replace(/w/g, 'v').replace(/[aeiouy]/g, '').replace(/(.)\1+/g, '$1');
  return s.slice(0, 4);
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function compile(raw) {
  const dict = raw.entities.map((e) => {
    const en = [], enCase = [], ru = [];
    for (const t of e.en ?? []) {
      if (t.startsWith('!')) enCase.push(new RegExp(`(?<![${L}])${esc(t.slice(1))}(?![${L}])`, 'u'));
      else en.push(norm(t).split(' ').map(esc).join(' '));
    }
    for (const t of e.ru ?? []) {
      if (t.startsWith('~')) ru.push(t.slice(1));
      else if (t.startsWith('=')) ru.push(esc(norm(t.slice(1))));
      else ru.push(norm(t).split(' ').map((p) => `${esc(p)}[а-я]*`).join(' '));
    }
    const wrap = (alts) => (alts.length ? new RegExp(`(?<![${L}])(?:${alts.join('|')})(?![${L}])`, 'u') : null);
    return { id: e.id, kind: e.kind, low: wrap([...en, ...ru]), cased: enCase };
  });
  return dict;
}

let DICT, COMMON = [];
const dict = () => {
  if (!DICT) {
    const raw = JSON.parse(readFileSync(new URL('./anchors.json', import.meta.url), 'utf8'));
    COMMON = raw.common ?? [];
    DICT = compile(raw);
  }
  return DICT;
};

const commonIds = () => (dict(), COMMON);

const plain = (s) => norm(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const stripHtml = (s) => (s ?? '').replace(/<[^>]*>/g, ' ');

const HITS_CAP = 50000;
const hitsCache = new Map(); // word → dictionary anchors (proper nouns repeat thousands of times)

function dictHitsRaw(text) {
  const low = plain(text);
  const out = new Map();
  for (const e of dict()) if ((e.low && e.low.test(low)) || e.cased.some((r) => r.test(text))) out.set(e.id, e.kind);
  return out;
}

function dictHitsWord(w) {
  let h = hitsCache.get(w);
  if (!h) {
    if (hitsCache.size >= HITS_CAP) hitsCache.clear();
    h = dictHitsRaw(w);
    hitsCache.set(w, h);
  }
  return h;
}

const dictHits = dictHitsRaw;

/**
 * Text anchors: dictionary ones (countries/cities/names/organizations/event types from anchors.json),
 * numbers and unknown proper nouns (by consonant skeleton, the same for Cyrillic and Latin).
 * Returns a Map: key → kind (geo | name | topic | num).
 */
export function anchors(text) {
  const out = dictHits(text);
  for (const m of text.matchAll(/(?<![\p{L}\p{N}.,])\d{2,}(?![\p{L}\p{N}])/gu)) {
    if (!/^(19|20)\d\d$/.test(m[0])) out.set(`#${m[0]}`, 'num');
  }
  for (const w of capitalized(text)) {
    if (dictHitsWord(w).size) continue;
    const sk = skeleton(w);
    if (sk.length >= 3) out.set(`~${sk}`, 'name');
  }
  return out;
}

function itemAnchors(it) {
  const title = anchors(headline(it.title));
  const all = new Map(title);
  for (const [k, v] of anchors(stripHtml(it.summary).slice(0, SUMMARY_CHARS))) all.set(k, v);
  return { title, all };
}

const timeOf = (it) => Date.parse(it.published ?? it.first_seen ?? '');

/** "Core" anchors of a group of records: anchors present in at least half of the records (so a chain through Trump does not pull in unrelated stories). */
function profile(members) {
  const need = members.length <= 2 ? 1 : Math.max(2, Math.ceil(members.length / 4)); // large story: anchor in a quarter of the records
  const count = (pick) => {
    const c = new Map();
    for (const m of members) for (const [k, v] of pick(m)) c.set(k, { kind: v, n: (c.get(k)?.n ?? 0) + 1 });
    return new Map([...c].filter(([, x]) => x.n >= need).map(([k, x]) => [k, x.kind]));
  };
  const times = members.map((m) => timeOf(m.item)).filter(Number.isFinite);
  return { all: count((m) => m.all), title: count((m) => m.title), from: Math.min(...times), to: Math.max(...times) };
}

/**
 * Anchor-merge rule for two groups of records: window ≤ 12 h; shared anchors (headline + start of the description)
 * weigh ≥ 2 (frequent anchors — Trump, USA, Russia — and generic event types such as «удар» (strike) and «война» (war) count 0.5 each); ≥ 1 shared for the headlines;
 * among the shared ones at least one specific (not geography and not a generic type), otherwise any two news items
 * about Israel and Gaza would merge.
 * weight(k) — anchor weight; default 1.
 */
export function anchorMatch(a, b, weight = () => 1) {
  const kindW = (k) => (a.all.get(k) === 'generic' ? 0.5 : 1);
  if (Number.isFinite(a.from) && Number.isFinite(b.from) && Math.max(a.from, b.from) - Math.min(a.to, b.to) > WIN_MS) return 0;
  const shared = [...a.all.keys()].filter((k) => b.all.has(k));
  const w = shared.reduce((s, k) => s + Math.min(weight(k), kindW(k)), 0);
  if (shared.length < 2 || w < 2) return 0;
  if (shared.filter((k) => Math.min(weight(k), kindW(k)) === 1).length < 2) return 0; // Trump + USA + «выборы» (elections) is not one event yet
  if (!shared.some((k) => a.title.has(k) && b.title.has(k))) return 0;
  if (!shared.some((k) => a.all.get(k) !== 'geo' && a.all.get(k) !== 'generic')) return 0;
  return w;
}

/**
 * Stage (b): groups left after stage (a) are merged by shared anchors in rounds — best pairs first;
 * a group's profile is recalculated after each round. Works for any pair of groups: ru↔en,
 * and paraphrases in the same language.
 */
function mergeByAnchors(items, info, find, union, groups) {
  const pub = (it) => groups[it.source] ?? it.source;
  const common = new Set(commonIds());
  const weight = (k) => (common.has(k) ? 0.5 : 1);
  for (let round = 0; round < 10; round++) {
    const members = new Map();
    items.forEach((_, i) => { if (info[i]) { const r = find(i); if (!members.has(r)) members.set(r, []); members.get(r).push(info[i]); } });
    const roots = [...members.keys()];
    const prof = new Map(roots.map((r) => [r, profile(members.get(r))]));
    const pubs = new Map(roots.map((r) => [r, new Set(members.get(r).map((m) => pub(m.item)))]));
    const sub = (x, y) => [...x].every((p) => y.has(p));
    // inverted index: anchor → groups. Merging requires ≥ 2 shared "weighty" anchors
    // (not common ones and not event types), so candidates are only pairs sharing two such anchors
    const index = new Map();
    roots.forEach((r, ri) => {
      for (const [k, kind] of prof.get(r).all) {
        if (kind === 'generic' || common.has(k)) continue;
        if (!index.has(k)) index.set(k, []);
        index.get(k).push(ri);
      }
    });
    const pairs = [];
    for (let a = 0; a < roots.length; a++) {
      const cnt = new Map();
      for (const [k, kind] of prof.get(roots[a]).all) {
        if (kind === 'generic' || common.has(k)) continue;
        for (const b of index.get(k)) if (b > a) cnt.set(b, (cnt.get(b) ?? 0) + 1);
      }
      const cands = [...cnt].filter(([, n]) => n >= 2).map(([b]) => b).sort((x, y) => x - y);
      for (const b of cands) {
        // items from the same feed (or the same publisher) do not confirm each other — do not merge
        if (sub(pubs.get(roots[a]), pubs.get(roots[b])) && sub(pubs.get(roots[b]), pubs.get(roots[a]))) continue;
        const w = anchorMatch(prof.get(roots[a]), prof.get(roots[b]), weight);
        if (w) pairs.push([w, roots[a], roots[b]]);
      }
    }
    pairs.sort((x, y) => y[0] - x[0]);
    const used = new Set();
    let merged = 0;
    for (const [, a, b] of pairs) {
      if (used.has(a) || used.has(b)) continue;
      used.add(a); used.add(b);
      union(a, b);
      merged++;
    }
    if (!merged) break;
  }
}

const PREP_CAP = 100000;
const prepCache = new Map(); // record id → parsed tokens/anchors; lives as long as the process (selection and metrics share it)

/** Parses a record (language, keys, anchors) once per record; the cache by id is checked against the title and description. */
function prep(it) {
  const cached = it.id != null ? prepCache.get(it.id) : null;
  if (cached && cached.title === it.title && cached.summary === it.summary) return cached;
  let ia;
  const p = {
    title: it.title, summary: it.summary,
    lang: langOf(it.title), keys: keys(it.title), digest: DIGEST.test(it.title),
    anchors: () => (ia ??= itemAnchors(it)),
  };
  if (it.id != null) {
    if (prepCache.size >= PREP_CAP) prepCache.clear();
    prepCache.set(it.id, p);
  }
  return p;
}

/**
 * Merging into clusters in two stages.
 * (a) within a language — weighted similarity of normalized keys ≥ threshold; the same link means the same event;
 * (b) across languages — by shared anchors (anchorMatch).
 * groups: feed → publisher (BBC World and BBC Russian Service = one agency): repeats from one publisher are not independent.
 */
export function cluster(items, threshold = 0.4, groups = {}) {
  const pre = items.map(prep);
  const lang = pre.map((p) => p.lang);
  const ks = pre.map((p) => p.keys);
  const digest = pre.map((p) => p.digest); // "Main news of the day" digests are not a single event
  const parent = items.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (i, j) => { parent[find(j)] = find(i); };
  // stage (a): candidates are records with a shared key (no shared key means similarity 0 < threshold); merge order unchanged
  const byLink = new Map(), post = new Map();
  const sums = ks.map((k) => { let s = 0; for (const w of k.values()) s += w; return s; });
  const push = (m, k, i) => { const l = m.get(k); if (l) l.push(i); else m.set(k, [i]); };
  items.forEach((it, i) => {
    push(byLink, it.link, i);
    if (!digest[i]) for (const k of ks[i].keys()) push(post, k, i);
  });
  for (let i = 0; i < items.length; i++) {
    const cand = new Set(byLink.get(items[i].link));
    if (!digest[i]) {
      // prefix filter: similarity ≥ threshold implies shared weight ≥ threshold·weight(i), and the most frequent keys
      // weigh at most 2 each — they can be skipped if together they do not reach that weight (the result stays exact)
      const byFreq = [...ks[i].keys()].sort((a, b) => post.get(b).length - post.get(a).length);
      let skip = 0;
      while (skip < byFreq.length && 2 * (skip + 1) < threshold * sums[i]) skip++;
      for (let n = skip; n < byFreq.length; n++) for (const j of post.get(byFreq[n])) cand.add(j);
    }
    for (const j of [...cand].sort((a, b) => a - b)) {
      if (j <= i || find(i) === find(j)) continue; // already in one cluster: union would change nothing
      if (items[i].link === items[j].link || (!digest[i] && !digest[j] && lang[i] === lang[j] && weightedSimilarity(ks[i], ks[j]) >= threshold)) union(i, j);
    }
  }
  const info = pre.map((p, i) => (digest[i] || !items[i].title ? null : { item: items[i], ...p.anchors() }));
  mergeByAnchors(items, info, find, union, groups);
  const byRoot = new Map();
  items.forEach((it, i) => {
    const r = find(i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(it);
  });
  return [...byRoot.values()].map((g) => buildCluster(g, groups));
}

function buildCluster(items, groups) {
  const sorted = [...items].sort((a, b) => (b.published ?? '').localeCompare(a.published ?? ''));
  // one record per publisher (groups merges feeds of one publisher, e.g. BBC): repeats are not independent
  const bySource = new Map();
  for (const it of sorted) { const k = groups[it.source] ?? it.source; if (!bySource.has(k)) bySource.set(k, it); }
  const sources = [...bySource.values()];
  return {
    title: sources[0].title,
    items: sorted,
    sources,
    sourceCount: sources.length,
    newest: sorted[0].published,
    status: sources.length >= 2 ? 'подтверждено' : 'не подтверждено',
  };
}
