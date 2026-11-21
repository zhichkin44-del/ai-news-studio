import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gate } from './gate.js';
import { cardText } from './markup.js';
import { DEFAULT_CONFIG } from './score.js';

/**
 * Custom infographic for a post: HTML 1080×1350 → PNG via headless Chrome/Edge.
 * Text and graphics from code only: no photos, no AI images, no links or outlet names.
 */
export const CARD_W = 1080;
export const CARD_H = 1350;
const YELLOW = '#ffd400';

export class CardError extends Error {
  constructor(code, message) { super(message); this.name = 'CardError'; this.code = code; }
}

export const brandOf = (config = DEFAULT_CONFIG) => String(config?.brand ?? 'ZHICHKIN NEWS');
export const cardModeOf = (config = DEFAULT_CONFIG) => (['always', 'fallback', 'off'].includes(config?.card_mode) ? config.card_mode : 'fallback');

// ───────── numbers ─────────

const num = (s) => Number(String(s).replace(/\s/g, '').replace(',', '.'));
const fmt = (s) => String(s).replace(/\s/g, '').replace('.', ',');

const VICTIM = [
  [/^погиб/i, 'погибших'], [/^жертв/i, 'жертв'], [/^ранен/i, 'раненых'], [/^пострадав/i, 'пострадавших'],
  [/^заложник/i, 'заложников'], [/^пассажир/i, 'пассажиров'], [/^эвакуирован/i, 'эвакуированных'],
];
const victimLabel = (w) => VICTIM.find(([re]) => re.test(w))?.[1] ?? null;
const CURRENCY = [
  [/^(долл|\$)/i, '$', 'долларов'], [/^(руб|₽)/i, '₽', 'рублей'], [/^(евро|€)/i, '€', 'евро'], [/^юан/i, '¥', 'юаней'],
];
const SCALE = { тыс: 'тыс.', млн: 'млн', млрд: 'млрд', трлн: 'трлн' };
const scaleOf = (w) => SCALE[String(w ?? '').toLowerCase().replace('.', '')] ?? null;
const UNITS = [[/^км/i, 'км'], [/^градус/i, 'градусов'], [/^баллов?/i, 'баллов'], [/^тонн/i, 'тонн'], [/^метр/i, 'метров']];

// Everyday units: forms "1 / 2–4 / 5+"; years — values above 120 are not counted (a year, not a duration)
const COUNT_UNITS = [
  [/^лет$|^год(?:а|ов|у|ам)?$/i, ['год', 'года', 'лет'], true],
  [/^час(?:а|ов|ам)?$/i, ['час', 'часа', 'часов']],
  [/^минут(?:а|ы|у)?$/i, ['минута', 'минуты', 'минут']],
  [/^(?:день|дня|дней|дням)$/i, ['день', 'дня', 'дней']],
  [/^сут(?:ки|ок)$/i, ['сутки', 'суток', 'суток']],
  [/^рейс(?:а|ов)?$/i, ['рейс', 'рейса', 'рейсов']],
  [/^дом(?:а|ов|ам|ах)?$/i, ['дом', 'дома', 'домов']],
  [/^школ(?:а|ы|у|ах)?$/i, ['школа', 'школы', 'школ']],
  [/^стран(?:а|ы|у|ах)?$/i, ['страна', 'страны', 'стран']],
  [/^квартир(?:а|ы|у|ах)?$/i, ['квартира', 'квартиры', 'квартир']],
  [/^больниц(?:а|ы|у|ах)?$/i, ['больница', 'больницы', 'больниц']],
  [/^семей$|^семь(?:я|и|ям)$/i, ['семья', 'семьи', 'семей']],
  [/^человек(?:а)?$/i, ['человек', 'человека', 'человек']],
];
const COUNT_RE = /(\d+(?:[.,]\d+)?)\s?([\p{L}]+)/gu;
const plural = (n, [one, few, many]) => {
  const i = Math.abs(Math.trunc(n));
  if (!Number.isInteger(n)) return few;
  if (i % 10 === 1 && i % 100 !== 11) return one;
  if (i % 10 >= 2 && i % 10 <= 4 && (i % 100 < 12 || i % 100 > 14)) return few;
  return many;
};

/** Number word next to casualties: «погибли двое» ("two died"), «трое раненых» ("three injured"). */
const WORD_NUM = {
  один: 1, одного: 1, одна: 1, двое: 2, два: 2, две: 2, двух: 2, трое: 3, три: 3, трёх: 3, трех: 3, четверо: 4, четыре: 4, четырёх: 4, четырех: 4,
  пятеро: 5, пять: 5, пяти: 5, шестеро: 6, шесть: 6, шести: 6, семеро: 7, семь: 7, семи: 7, восемь: 8, восьми: 8, девять: 9, девяти: 9, десять: 10, десяти: 10,
};
const WORD_NUM_RE = Object.keys(WORD_NUM).join('|');
const CASUALTY = new Set(['погибших', 'жертв', 'раненых', 'пострадавших', 'заложников']); // outranks percentages and money

function victimFigures(t) {
  const figures = [];
  // «30 человек погибли» ("30 people died"), «80 раненых» ("80 injured"), «трое раненых» ("three injured")
  const re1 = new RegExp(`(\\d{1,3}(?:[  ]\\d{3})*|\\d+|(?<![\\p{L}])(?:${WORD_NUM_RE}))\\s+(человек\\p{L}*\\s+)?(погиб\\p{L}*|жертв\\p{L}*|ранен\\p{L}*|пострадав\\p{L}*|заложник\\p{L}*|пассажир\\p{L}*|эвакуирован\\p{L}*)`, 'giu');
  for (const x of t.matchAll(re1)) {
    const label = victimLabel(x[3]);
    const value = WORD_NUM[x[1].toLowerCase()] ?? num(x[1]);
    if (label) figures.push({ value, label });
  }
  // «погибли 12» ("12 died"), «погибли двое» ("two died"), «ранены пятеро» ("five injured")
  const re2 = new RegExp(`(погиб\\p{L}*|ранен\\p{L}*|пострадал\\p{L}*)\\s+(?:более\\s+|около\\s+|не менее\\s+)?(\\d+|(?<![\\p{L}])(?:${WORD_NUM_RE}))(?![\\p{L}\\d])(?!\\s?(?:%|лет))`, 'giu');
  for (const x of t.matchAll(re2)) {
    const label = victimLabel(x[1]);
    const value = WORD_NUM[x[2].toLowerCase()] ?? num(x[2]);
    if (label) figures.push({ value, label });
  }
  return figures.filter((f, i) => figures.findIndex((g) => g.label === f.label) === i);
}

const victimsResult = (dedup) => {
  const top = dedup.find((f) => f.label === 'погибших') ?? dedup.reduce((a, b) => (b.value > a.value ? b : a));
  const other = dedup.find((f) => f !== top);
  return { text: String(top.value), unit: top.label, kind: 'victims', value: top.value, second: other ? { value: other.value, label: other.label } : null };
};

/**
 * A notable figure in the post text, via regexes: number of casualties, percentage, sum, value with a unit.
 * Casualties outrank percentages and money. → { text:'30', unit:'погибших', kind:'victims'|'percent'|'money'|'value', value, share?, second? } | null.
 * Years and dates written as digits are not counted.
 */
export function extractNumber(text) {
  const t = String(text ?? '').replace(/ /g, ' ');
  const dedup = victimFigures(t);
  if (dedup.some((f) => CASUALTY.has(f.label))) return victimsResult(dedup);
  let m = t.match(/(\d+(?:[.,]\d+)?)\s?(%|процент\w*)/i);
  if (m) {
    const value = num(m[1]);
    return { text: `${fmt(m[1])}%`, unit: '', kind: 'percent', value, share: value <= 100 ? value / 100 : null };
  }
  m = t.match(/(\d+(?:[.,]\d+)?)\s?(тыс\.?|млн|млрд|трлн)?\s?(долл\w*|руб\w*|евро|юан\w*|\$|€|₽)/i);
  if (m) {
    const cur = CURRENCY.find(([re]) => re.test(m[3]));
    const scale = scaleOf(m[2]);
    const body = `${fmt(m[1])}${scale ? ` ${scale}` : ''}`;
    return { text: cur[1] === '$' || cur[1] === '€' ? `${cur[1]}${body}` : `${body} ${cur[1]}`, unit: cur[2], kind: 'money', value: num(m[1]) };
  }
  if (dedup.length) return victimsResult(dedup);
  m = t.match(/магнитуд\p{L}*\s+(\d+(?:[.,]\d+)?)/iu);
  if (m) return { text: fmt(m[1]), unit: 'магнитуда', kind: 'value', value: num(m[1]) };
  m = t.match(/(\d+(?:[.,]\d+)?)\s?(тыс\.?|млн|млрд|трлн)(?![\p{L}])\s?([\p{L}]+)?/iu);
  if (m) return { text: `${fmt(m[1])} ${scaleOf(m[2])}`, unit: m[3] ?? '', kind: 'value', value: num(m[1]) };
  m = t.match(/(\d+(?:[.,]\d+)?)\s?(км|градус\p{L}*|баллов?|тонн\p{L}*|метр\p{L}*)(?![\p{L}])/iu);
  if (m) return { text: fmt(m[1]), unit: UNITS.find(([re]) => re.test(m[2]))?.[1] ?? m[2], kind: 'value', value: num(m[1]) };
  for (const x of t.matchAll(COUNT_RE)) {
    const unit = COUNT_UNITS.find(([re]) => re.test(x[2]));
    if (!unit) continue;
    const value = num(x[1]);
    if (unit[2] && value > 120) continue; // «2026 году» ("in 2026") — a date, not a duration
    return { text: fmt(x[1]), unit: plural(value, unit[1]), kind: 'value', value };
  }
  return null;
}

/** Layout: "number" if the post has a notable figure, otherwise "headline". */
export const pickLayout = (text) => (extractNumber(cardText(text)) ? 'number' : 'headline');

// ───────── text ─────────

const stripEmoji = (s) => String(s ?? '').replace(/[\p{Extended_Pictographic}️‍]/gu, '').replace(/[ \t]+/g, ' ').trim();

/**
 * Headline = the first line of the post (or its first sentence if the line is too long); caption = the first sentence(s) of the rest.
 * Markup is stripped; the <blockquote> block (layer 3, details) does not make it onto the card.
 */
export function splitPost(text) {
  const clean = stripEmoji(cardText(text)).replace(/\r/g, '');
  const [first = '', ...rest] = clean.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  let head = first;
  let tail = rest.join(' ');
  if (head.length > 140) {
    const cut = head.search(/[.!?…](\s|$)/);
    if (cut > 20) { tail = `${head.slice(cut + 1).trim()} ${tail}`.trim(); head = head.slice(0, cut + 1); }
  }
  head = head.replace(/[.\s]+$/, '');
  const sentences = tail.match(/[^.!?…]+[.!?…]*/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
  let caption = '';
  for (const s of sentences) { if ((caption + ' ' + s).trim().length > 220) break; caption = `${caption} ${s}`.trim(); }
  if (!caption && tail) caption = tail.slice(0, 220).trim();
  return { headline: head, caption, rest: tail };
}

const TAIL_WORDS = /^(?:в|во|на|у|к|ко|с|со|и|а|но|о|об|от|из|за|по|до|для|при|над|под|же|что|как|это|эти|обе|все|его|её|их|—|-)$/i;
const DANGLING = /(?:ого|его|ой|ей|ых|их|ым|им|ую|юю|ая|яя|ое|ее|ые|ие)$/i; // a dangling adjective at the end of a truncated title
const TITLE_WORDS = 8;
const TITLE_CHARS = 70;
const wordsOf = (s) => s.split(/\s+/).filter(Boolean);

/**
 * Short card title (6–8 words, ≤70 characters): up to a colon, dash or first comma —
 * so as not to repeat the figure and the whole post text. A short headline is kept as is.
 */
export function cardTitle(headline) {
  let t = String(headline ?? '').replace(/\s+/g, ' ').trim();
  for (const re of [/:\s/, /\s[—–-]\s/, /,\s/]) {
    const at = t.search(re);
    if (at > 0 && wordsOf(t.slice(0, at)).length >= 3) { t = t.slice(0, at); break; }
  }
  let w = wordsOf(t);
  const cutByLimit = w.length > TITLE_WORDS || t.length > TITLE_CHARS;
  if (w.length > TITLE_WORDS) w = w.slice(0, TITLE_WORDS);
  while (w.length > 3 && w.join(' ').length > TITLE_CHARS) w.pop();
  while (w.length > 3 && (TAIL_WORDS.test(w.at(-1)) || (cutByLimit && DANGLING.test(w.at(-1))))) w.pop();
  return w.join(' ').replace(/[\s,;:—–-]+$/, '');
}

/** Short lead line for the no-figure layout (≤90 characters): the gist of the «Что это значит / Что сейчас» line, or the first sentence after the headline. */
export function cardCaption(caption, title, max = 90) {
  const flat = String(caption ?? '').replace(/•\s*/g, '').replace(/\s+/g, ' ').trim();
  const sense = flat.match(/Что (?:это значит|сейчас)\s*:\s*(.+)$/i);
  const src = sense ? sense[1] : flat;
  const first = src.match(/[^.!?…]+[.!?…]*/)?.[0].trim() ?? '';
  let out = first;
  if (out.length > max) {
    const w = out.slice(0, max).replace(/[\s,;:—-]*\S*$/, '').split(/\s+/);
    while (w.length > 3 && TAIL_WORDS.test(w.at(-1).replace(/[,;:]+$/, ''))) w.pop();
    out = `${w.join(' ').replace(/[\s,;:—-]+$/, '')}…`;
  }
  out = out.replace(/\.$/, '');
  return out === title ? '' : out;
}

/** Word wrap by estimated width; a word longer than a line is split. */
export function wrapText(text, maxChars) {
  const lines = [];
  let cur = '';
  for (let word of String(text).split(/\s+/).filter(Boolean)) {
    while (word.length > maxChars) {
      if (cur) { lines.push(cur); cur = ''; }
      lines.push(word.slice(0, maxChars));
      word = word.slice(maxChars);
    }
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= maxChars) cur += ` ${word}`;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  return lines;
}

const CHAR_W = 0.58; // average glyph width of a bold font size, in em (with a margin)

/**
 * Picks the font size: the largest at which the text fits in width and maxLines lines
 * (and, when height and lh are given, in height too); at the minimum — truncated with «…».
 */
export function fitText(text, { width, maxLines, maxSize, minSize, step = 2, height = Infinity, lh = 1.12 }) {
  const cap = (size) => Math.max(1, Math.min(maxLines, Math.floor(height / (size * lh))));
  for (let size = maxSize; size >= minSize; size -= step) {
    const lines = wrapText(text, Math.floor(width / (size * CHAR_W)));
    if (lines.length <= cap(size)) return { size, lines };
  }
  const lines = wrapText(text, Math.floor(width / (minSize * CHAR_W))).slice(0, cap(minSize));
  const last = lines.length - 1;
  if (last >= 0) {
    const l = lines[last];
    lines[last] = `${(/\s/.test(l) ? l.replace(/\s+\S*$/, '') : l.slice(0, -1)).replace(/[\s.,;:—-]+$/, '')}…`; // cut at a word boundary
  }
  return { size: minSize, lines };
}

// ───────── category ─────────

const EMERGENCY = /погиб|жертв|убит|теракт|взрыв|катастроф|авари|крушен|пожар|землетряс|наводнен|ураган|цунами|извержен|стрельб|заложник|обрушен/i;
const MONEY = /нефт|рубл|биржа|биржи|курс\b|доллар|евро\b|инфляц|ставк|биткоин|акци[йи]|экономик|банк|налог|санкци/i;
const CATEGORY_LABEL = { science: 'Наука', tech: 'Технологии', space: 'Космос', health: 'Здоровье', economy: 'Деньги' };

/** Category label: ЧП (incidents), Наука (science), Технологии (tech), Космос (space), Здоровье (health), Деньги (money) or Мир (world). */
export function labelFor(text, category) {
  if (CATEGORY_LABEL[category]) return CATEGORY_LABEL[category];
  if (EMERGENCY.test(text)) return 'ЧП';
  if (MONEY.test(text)) return 'Деньги';
  return 'Мир';
}

const P = 'fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"';
const ICONS = {
  'ЧП': `<path ${P} d="M32 6 60 56H4Z"/><path ${P} d="M32 24v16"/><circle cx="32" cy="47" r="2.4" fill="currentColor"/>`,
  'Наука': `<path ${P} d="M24 6h16M28 6v16L10 54a4 4 0 0 0 4 6h36a4 4 0 0 0 4-6L36 22V6"/><path ${P} d="M18 42h28"/>`,
  'Технологии': `<rect ${P} x="16" y="16" width="32" height="32" rx="3"/><rect ${P} x="25" y="25" width="14" height="14"/><path ${P} d="M24 6v10M40 6v10M24 48v10M40 48v10M6 24h10M6 40h10M48 24h10M48 40h10"/>`,
  'Космос': `<circle ${P} cx="32" cy="32" r="12"/><ellipse ${P} cx="32" cy="32" rx="28" ry="9" transform="rotate(-25 32 32)"/>`,
  'Здоровье': `<path ${P} d="M24 6h16v18h18v16H40v18H24V40H6V24h18z"/>`,
  'Деньги': `<circle ${P} cx="32" cy="32" r="26"/><path ${P} d="M40 22H28a6 6 0 0 0 0 12h8a6 6 0 0 1 0 12H22M32 15v6M32 47v6"/>`,
  'Мир': `<circle ${P} cx="32" cy="32" r="26"/><ellipse ${P} cx="32" cy="32" rx="11" ry="26"/><path ${P} d="M6 32h52M10 18h44M10 46h44"/>`,
};
export const iconSvg = (label, size = 96) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" style="color:${YELLOW}">${ICONS[label] ?? ICONS['Мир']}</svg>`;
export const LABELS = Object.keys(ICONS);

// ───────── HTML ─────────

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/** "14:05 · 30 октября" in Moscow time (tz_hours from the daily settings). */
export function stamp(time = new Date(), tz = DEFAULT_CONFIG.daily?.tz_hours ?? 3) {
  const t = new Date(time);
  const d = new Date((Number.isNaN(t.getTime()) ? Date.now() : t.getTime()) + tz * 3600_000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} · ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

const lines = (fit, color, weight = 800, lh = 1.12) =>
  fit.lines.map((l) => `<div style="font-size:${fit.size}px;line-height:${lh};color:${color};font-weight:${weight};white-space:nowrap;overflow:hidden">${esc(l)}</div>`).join('');

function bars(n) {
  const row = (label, share, strong) => `<div style="display:flex;align-items:center;gap:24px;margin-top:18px"><div style="flex:1;height:30px;background:#34373c"><div style="width:${Math.max(2, Math.round(share * 100))}%;height:30px;background:${strong ? YELLOW : '#8d9096'}"></div></div><div style="width:230px;font-size:28px;color:#b9bcc2;font-weight:700;white-space:nowrap">${esc(label)}</div></div>`;
  if (n.kind === 'percent' && n.share !== null) return row('', n.share, true);
  if (n.second && n.second.value > 0 && n.value > 0) {
    const max = Math.max(n.value, n.second.value);
    return row(`${n.value} ${n.unit}`, n.value / max, true) + row(`${n.second.value} ${n.second.label}`, n.second.value / max, false);
  }
  return `<div style="margin-top:24px;height:14px;width:240px;background:${YELLOW}"></div>`;
}

/** Everything visible on the card, without markup — for the gate. */
export function cardModel(post, { config = DEFAULT_CONFIG } = {}) {
  const text = String(post?.text ?? '');
  const { headline, rest } = splitPost(text);
  const visible = cardText(text); // without layer 3: the figure is taken only from the visible part
  const n = extractNumber(visible);
  const label = labelFor(headline, post?.category); // ЧП and Деньги — by headline only, not the whole text
  const title = cardTitle(headline) || headline;
  // with a figure the post text is not duplicated on the card; without one — a single short lead line
  return { layout: n ? 'number' : 'headline', label, headline, title, caption: n ? '' : cardCaption(rest, title), number: n, stamp: stamp(post?.time, config.daily?.tz_hours), brand: brandOf(config) };
}

export function cardTexts(model) {
  return [model.label, model.title ?? model.headline, model.caption, model.number?.text, model.number?.unit, model.number?.second?.label, model.stamp, model.brand].filter(Boolean);
}

/** Gate for the card text: no links, @names, outlet names or stop-words may appear. */
export function gateCard(model) {
  return gate({ body: cardTexts(model).join('\n') });
}

export function cardHtml(model) {
  const W = CARD_W - 160;
  const foot = `<div style="position:absolute;left:80px;right:80px;bottom:64px;display:flex;justify-content:space-between;align-items:center;border-top:4px solid #3c3f45;padding-top:28px;font-size:32px;font-weight:700;color:#b9bcc2"><span>${esc(model.stamp)}</span><span style="color:${YELLOW};letter-spacing:3px">${esc(model.brand)}</span></div>`;
  const chip = `<div style="position:absolute;left:80px;top:90px;display:flex;align-items:center;gap:28px">${iconSvg(model.label, model.layout === 'number' ? 84 : 120)}<span style="font-size:${model.layout === 'number' ? 44 : 56}px;font-weight:800;color:${YELLOW};letter-spacing:4px;text-transform:uppercase">${esc(model.label)}</span></div>`;
  let body;
  if (model.layout === 'number') {
    const big = fitText(model.number.text, { width: W, maxLines: 1, maxSize: 270, minSize: 110, step: 6, lh: 1.05 });
    const bigH = Math.round(big.size * 1.05);
    const unit = model.number.unit ? `<div style="font-size:36px;font-weight:700;color:#b9bcc2;white-space:nowrap;overflow:hidden;margin-top:6px">${esc(model.number.unit)}</div>` : '';
    // title short and large; no small duplicate of the post text below it
    const head = fitText(model.title ?? model.headline, { width: W, maxLines: 3, maxSize: 76, minSize: 42, height: 300 });
    body = `<div style="position:absolute;left:80px;top:230px;width:${W}px;height:${bigH}px;overflow:hidden">${lines(big, YELLOW, 900, 1.05)}</div>
<div style="position:absolute;left:80px;top:${230 + bigH}px;width:${W}px;height:${unit ? 190 : 140}px;overflow:hidden">${unit}${bars(model.number)}</div>
<div style="position:absolute;left:80px;top:820px;width:${W}px;height:310px;overflow:hidden">${lines(head, '#fff', 800, 1.12)}</div>`;
  } else {
    // no figure: large title, yellow divider, short lead line
    const head = fitText(model.title ?? model.headline, { width: W, maxLines: 4, maxSize: 112, minSize: 52, height: 540 });
    const cap = model.caption ? fitText(model.caption, { width: W, maxLines: 2, maxSize: 44, minSize: 30, height: 130, lh: 1.25 }) : null;
    body = `<div style="position:absolute;left:80px;top:330px;width:${W}px;height:800px;overflow:hidden">${lines(head, '#fff', 900)}<div style="margin-top:40px;height:14px;width:240px;background:${YELLOW}"></div>${cap ? `<div style="margin-top:36px">${lines(cap, '#b9bcc2', 600, 1.25)}</div>` : ''}</div>`;
  }
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}body{width:${CARD_W}px;height:${CARD_H}px;background:#222428;font-family:'Segoe UI','Arial',sans-serif;position:relative;overflow:hidden}</style></head><body><div style="position:absolute;left:0;top:0;width:${CARD_W}px;height:22px;background:${YELLOW}"></div>${chip}${body}${foot}</body></html>`;
}

// ───────── browser ─────────

const WIN_PATHS = (env) => {
  const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
  return roots.flatMap((r) => [`${r}/Google/Chrome/Application/chrome.exe`, `${r}/Microsoft/Edge/Application/msedge.exe`]);
};
const OTHER_PATHS = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];

/** Path to Chrome/Edge: CARD_BROWSER first, then the standard Windows locations. null — not found. */
export function findBrowser({ env = process.env, exists = existsSync } = {}) {
  if (env.CARD_BROWSER) return exists(env.CARD_BROWSER) ? env.CARD_BROWSER : null;
  return [...WIN_PATHS(env), ...OTHER_PATHS].find((p) => exists(p)) ?? null;
}

const run = (cmd, args, timeout) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout, windowsHide: true }, (err) => (err ? reject(err) : resolve()));
});

const pngSize = (buf) => (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : null);

/**
 * Post → PNG 1080×1350. post: { text, category?, time? }. Returns { file, sha256, width, height, layout, label }.
 * No browser, or the gate failed — CardError (code 'no-browser' | 'gate' | 'render'), without crashing the process.
 */
export async function renderCard(post, { outFile, config = DEFAULT_CONFIG, browser, exec = run, timeoutMs = 40000 } = {}) {
  const model = cardModel(post, { config });
  if (!model.headline) throw new CardError('empty', 'card: empty post text');
  const g = gateCard(model);
  if (!g.ok) throw new CardError('gate', `card did not pass the gate: ${g.reasons.join('; ')}`);
  const exe = browser === undefined ? findBrowser() : browser;
  if (!exe) throw new CardError('no-browser', 'card: Chrome/Edge not found — install a browser or set CARD_BROWSER');
  if (!outFile) throw new CardError('render', 'card: no output file set');
  const tmp = await mkdtemp(join(tmpdir(), 'card-'));
  try {
    const html = join(tmp, 'card.html');
    await writeFile(html, cardHtml(model), 'utf8');
    await mkdir(dirname(outFile), { recursive: true });
    let buf = null;
    for (const mode of ['--headless', '--headless=new']) {
      try {
        await exec(exe, [mode, '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', `--user-data-dir=${join(tmp, 'profile')}`, `--window-size=${CARD_W},${CARD_H}`, `--screenshot=${outFile}`, pathToFileURL(html).href], timeoutMs);
        buf = await readFile(outFile);
      } catch { buf = null; }
      const s = buf && pngSize(buf);
      if (s && s.width === CARD_W && s.height === CARD_H) break;
      buf = null;
    }
    if (!buf) throw new CardError('render', 'card: browser did not produce a 1080×1350 PNG');
    return { file: outFile, sha256: createHash('sha256').update(buf).digest('hex'), width: CARD_W, height: CARD_H, layout: model.layout, label: model.label };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
