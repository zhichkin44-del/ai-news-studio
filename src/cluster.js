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

/** Язык заголовка по алфавиту: ru — если кириллицы больше, иначе en. */
export function langOf(title) {
  const cyr = (title.match(/\p{Script=Cyrillic}/gu) ?? []).length;
  const lat = (title.match(/\p{Script=Latin}/gu) ?? []).length;
  return cyr > lat ? 'ru' : 'en';
}

/** Грубая основа слова: срезаем окончания (ru — список, en — s/ed/ing), не короче 3 букв, не длиннее 6. */
export function stem(w) {
  const ends = isCyr(w) ? RU_ENDINGS : EN_ENDINGS;
  if (!/\p{L}/u.test(w)) return w;
  for (const e of ends) if (w.length - e.length >= 3 && w.endsWith(e)) { w = w.slice(0, -e.length); break; }
  return w.slice(0, 6);
}

/** Составной заголовок NPR «Тема А. And, тема Б» — главная тема только первая. */
const headline = (title) => title.split(/\.\s+And,?\s/)[0];

/** Слова заголовка, начинающиеся с заглавной не в начале (имена собственные). */
function capitalized(title) {
  const raw = title.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
  return raw.slice(1).filter((w) => /^\p{Lu}/u.test(w) && w.replace(/['’-]/g, '').length >= 4);
}

/** Ключи для внутриязыковой склейки: основа → вес (числа и имена собственные весят 2). */
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

/** Взвешенное сходство Жаккара между наборами ключей. */
export function weightedSimilarity(a, b) {
  if (!a.size || !b.size) return 0;
  let common = 0, sa = 0, sb = 0;
  for (const w of a.values()) sa += w;
  for (const w of b.values()) sb += w;
  for (const [k, w] of a) if (b.has(k)) common += Math.max(w, b.get(k));
  return common / (sa + sb - common);
}

// ---------- якоря ----------

const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };

/** Согласный скелет имени: кириллица и латиница сводятся к одному ключу (Нетаньяху / Netanyahu → ntnh). */
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

function dictHits(text) {
  const low = plain(text);
  const out = new Map();
  for (const e of dict()) if ((e.low && e.low.test(low)) || e.cased.some((r) => r.test(text))) out.set(e.id, e.kind);
  return out;
}

/**
 * Якоря текста: словарные (страны/города/имена/организации/типы событий из anchors.json),
 * числа и неизвестные имена собственные (по согласному скелету, одинаковому для кириллицы и латиницы).
 * Возвращает Map: ключ → вид (geo | name | topic | num).
 */
export function anchors(text) {
  const out = dictHits(text);
  for (const m of text.matchAll(/(?<![\p{L}\p{N}.,])\d{2,}(?![\p{L}\p{N}])/gu)) {
    if (!/^(19|20)\d\d$/.test(m[0])) out.set(`#${m[0]}`, 'num');
  }
  for (const w of capitalized(text)) {
    if (dictHits(w).size) continue;
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

/** «Ядро» якорей группы записей: якоря, которые есть не менее чем у половины записей (так цепочка через Трампа не тянет чужое). */
function profile(members) {
  const need = members.length <= 2 ? 1 : Math.max(2, Math.ceil(members.length / 4)); // большой сюжет: якорь у четверти записей
  const count = (pick) => {
    const c = new Map();
    for (const m of members) for (const [k, v] of pick(m)) c.set(k, { kind: v, n: (c.get(k)?.n ?? 0) + 1 });
    return new Map([...c].filter(([, x]) => x.n >= need).map(([k, x]) => [k, x.kind]));
  };
  const times = members.map((m) => timeOf(m.item)).filter(Number.isFinite);
  return { all: count((m) => m.all), title: count((m) => m.title), from: Math.min(...times), to: Math.max(...times) };
}

/**
 * Правило склейки двух групп записей по якорям: окно ≤ 12 ч; общие якоря (заголовок + начало описания)
 * весят ≥ 2 (частые якоря — Трамп, США, Россия — и общие типы событий — «удар», «война» — по 0,5); ≥ 1 общий для заголовков;
 * среди общих хотя бы один конкретный (не география и не общий тип), иначе любые две новости
 * про Израиль и Газу склеились бы.
 * weight(k) — вес якоря; по умолчанию 1.
 */
export function anchorMatch(a, b, weight = () => 1) {
  const kindW = (k) => (a.all.get(k) === 'generic' ? 0.5 : 1);
  if (Number.isFinite(a.from) && Number.isFinite(b.from) && Math.max(a.from, b.from) - Math.min(a.to, b.to) > WIN_MS) return 0;
  const shared = [...a.all.keys()].filter((k) => b.all.has(k));
  const w = shared.reduce((s, k) => s + Math.min(weight(k), kindW(k)), 0);
  if (shared.length < 2 || w < 2) return 0;
  if (shared.filter((k) => Math.min(weight(k), kindW(k)) === 1).length < 2) return 0; // Трамп + США + «выборы» — это ещё не одно событие
  if (!shared.some((k) => a.title.has(k) && b.title.has(k))) return 0;
  if (!shared.some((k) => a.all.get(k) !== 'geo' && a.all.get(k) !== 'generic')) return 0;
  return w;
}

/**
 * Этап (б): группы после этапа (а) склеиваются по общим якорям раундами — лучшие пары первыми;
 * профиль группы пересчитывается после каждого раунда. Работает для любых пар групп: и ru↔en,
 * и пересказы в одном языке другими словами.
 */
function mergeByAnchors(items, find, union, groups) {
  const pub = (it) => groups[it.source] ?? it.source;
  const info = items.map((item) => (item.title ? { item, ...itemAnchors(item) } : null));
  const common = new Set(commonIds());
  const weight = (k) => (common.has(k) ? 0.5 : 1);
  for (let round = 0; round < 10; round++) {
    const members = new Map();
    items.forEach((_, i) => { if (info[i]) { const r = find(i); if (!members.has(r)) members.set(r, []); members.get(r).push(info[i]); } });
    const roots = [...members.keys()];
    const prof = new Map(roots.map((r) => [r, profile(members.get(r))]));
    const pubs = new Map(roots.map((r) => [r, new Set(members.get(r).map((m) => pub(m.item)))]));
    const sub = (x, y) => [...x].every((p) => y.has(p));
    const pairs = [];
    for (let a = 0; a < roots.length; a++)
      for (let b = a + 1; b < roots.length; b++) {
        // события одной и той же ленты (или одного издателя) друг друга не подтверждают — не склеиваем
        if (sub(pubs.get(roots[a]), pubs.get(roots[b])) && sub(pubs.get(roots[b]), pubs.get(roots[a]))) continue;
        const w = anchorMatch(prof.get(roots[a]), prof.get(roots[b]), weight);
        if (w) pairs.push([w, roots[a], roots[b]]);
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

/**
 * Склейка в кластеры в два этапа.
 * (а) внутри языка — взвешенное сходство нормализованных ключей ≥ threshold; одинаковая ссылка — то же событие;
 * (б) между языками — по общим якорям (anchorMatch).
 * groups: лента → издатель (BBC World и BBC Русская служба = одно агентство): повторы издателя не независимы.
 */
export function cluster(items, threshold = 0.4, groups = {}) {
  const lang = items.map((i) => langOf(i.title));
  const ks = items.map((i) => keys(i.title));
  const digest = items.map((i) => DIGEST.test(i.title)); // дайджесты «Главные новости дня» — не одно событие
  const parent = items.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (i, j) => { parent[find(j)] = find(i); };
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++)
      if (items[i].link === items[j].link || (!digest[i] && !digest[j] && lang[i] === lang[j] && weightedSimilarity(ks[i], ks[j]) >= threshold)) union(i, j);
  mergeByAnchors(items.map((it, i) => (digest[i] ? { ...it, title: '' } : it)), find, union, groups);
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
  // одна запись на издателя (groups сводит ленты одного издателя, напр. BBC): повторы не независимы
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
