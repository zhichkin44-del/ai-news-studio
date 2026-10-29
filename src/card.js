import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gate } from './gate.js';
import { DEFAULT_CONFIG } from './score.js';

/**
 * Своя инфографика к посту: HTML 1080×1350 → PNG через Chrome/Edge headless.
 * Только текст и графика из кода: ни фото, ни ИИ-картинок, ни ссылок и названий изданий.
 */
export const CARD_W = 1080;
export const CARD_H = 1350;
const YELLOW = '#ffd400';

export class CardError extends Error {
  constructor(code, message) { super(message); this.name = 'CardError'; this.code = code; }
}

export const brandOf = (config = DEFAULT_CONFIG) => String(config?.brand ?? 'НИЧЕГО СЕБЕ');
export const cardModeOf = (config = DEFAULT_CONFIG) => (['always', 'fallback', 'off'].includes(config?.card_mode) ? config.card_mode : 'fallback');

// ───────── числа ─────────

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

/**
 * Заметная цифра в тексте поста, регулярками: процент, сумма, число жертв, величина с единицей.
 * → { text:'30', unit:'погибших', kind:'victims'|'percent'|'money'|'value', value, share?, second? } | null.
 * Годы и даты цифрой не считаются.
 */
export function extractNumber(text) {
  const t = String(text ?? '').replace(/ /g, ' ');
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
  // «30 человек погибли», «80 раненых», «погибли 12»
  const figures = [];
  for (const x of t.matchAll(/(\d{1,3}(?:[  ]\d{3})*|\d+)\s+(человек\p{L}*\s+)?(погиб\p{L}*|жертв\p{L}*|ранен\p{L}*|пострадав\p{L}*|заложник\p{L}*|пассажир\p{L}*|эвакуирован\p{L}*)/giu)) {
    const label = victimLabel(x[3]);
    if (label) figures.push({ value: num(x[1]), label });
  }
  for (const x of t.matchAll(/(погиб\p{L}*|ранен\p{L}*|пострадал\p{L}*)\s+(?:более\s+|около\s+|не менее\s+)?(\d+)\b(?!\s?(?:%|лет))/giu)) {
    const label = victimLabel(x[1]);
    if (label) figures.push({ value: num(x[2]), label });
  }
  const dedup = figures.filter((f, i) => figures.findIndex((g) => g.label === f.label) === i);
  if (dedup.length) {
    const top = dedup.find((f) => f.label === 'погибших') ?? dedup.reduce((a, b) => (b.value > a.value ? b : a));
    const other = dedup.find((f) => f !== top);
    return { text: String(top.value), unit: top.label, kind: 'victims', value: top.value, second: other ? { value: other.value, label: other.label } : null };
  }
  m = t.match(/магнитуд\p{L}*\s+(\d+(?:[.,]\d+)?)/iu);
  if (m) return { text: fmt(m[1]), unit: 'магнитуда', kind: 'value', value: num(m[1]) };
  m = t.match(/(\d+(?:[.,]\d+)?)\s?(тыс\.?|млн|млрд|трлн)(?![\p{L}])\s?([\p{L}]+)?/iu);
  if (m) return { text: `${fmt(m[1])} ${scaleOf(m[2])}`, unit: m[3] ?? '', kind: 'value', value: num(m[1]) };
  m = t.match(/(\d+(?:[.,]\d+)?)\s?(км|градус\p{L}*|баллов?|тонн\p{L}*|метр\p{L}*)(?![\p{L}])/iu);
  if (m) return { text: fmt(m[1]), unit: UNITS.find(([re]) => re.test(m[2]))?.[1] ?? m[2], kind: 'value', value: num(m[1]) };
  return null;
}

/** Макет: «Цифра», если в посте есть заметная цифра, иначе «Заголовок». */
export const pickLayout = (text) => (extractNumber(text) ? 'number' : 'headline');

// ───────── текст ─────────

const stripEmoji = (s) => String(s ?? '').replace(/[\p{Extended_Pictographic}️‍]/gu, '').replace(/[ \t]+/g, ' ').trim();

/** Заголовок = первая строка поста (или первая фраза, если строка слишком длинная); подпись = первая фраза(ы) остального. */
export function splitPost(text) {
  const clean = stripEmoji(text).replace(/\r/g, '');
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
  return { headline: head, caption };
}

/** Перенос по словам по оценке ширины; слово длиннее строки режется. */
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

const CHAR_W = 0.58; // средняя ширина знака жирного кегля, в em (с запасом)

/**
 * Подбирает кегль: самый крупный, при котором текст влезает в width и в maxLines строк
 * (а при заданных height и lh — и по высоте); на минимуме — обрезка с «…».
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
    lines[last] = `${(/\s/.test(l) ? l.replace(/\s+\S*$/, '') : l.slice(0, -1)).replace(/[\s.,;:—-]+$/, '')}…`; // режем по слову
  }
  return { size: minSize, lines };
}

// ───────── категория ─────────

const EMERGENCY = /погиб|жертв|убит|теракт|взрыв|катастроф|авари|крушен|пожар|землетряс|наводнен|ураган|цунами|извержен|стрельб|заложник|обрушен/i;
const MONEY = /нефт|рубл|биржа|биржи|курс\b|доллар|евро\b|инфляц|ставк|биткоин|акци[йи]|экономик|банк|налог|санкци/i;
const CATEGORY_LABEL = { science: 'Наука', tech: 'Технологии', space: 'Космос', health: 'Здоровье', economy: 'Деньги' };

/** Метка категории: ЧП, Наука, Технологии, Космос, Здоровье, Деньги или Мир. */
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

/** «14:05 · 30 октября» по МСК (tz_hours из daily-настроек). */
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

/** Всё, что видно на карточке, без разметки — для ворот. */
export function cardModel(post, { config = DEFAULT_CONFIG } = {}) {
  const text = String(post?.text ?? '');
  const { headline, caption } = splitPost(text);
  const n = extractNumber(text);
  const label = labelFor(headline, post?.category); // ЧП и Деньги — только по заголовку, не по всему тексту
  return { layout: n ? 'number' : 'headline', label, headline, caption: n ? caption : '', number: n, stamp: stamp(post?.time, config.daily?.tz_hours), brand: brandOf(config) };
}

export function cardTexts(model) {
  return [model.label, model.headline, model.caption, model.number?.text, model.number?.unit, model.number?.second?.label, model.stamp, model.brand].filter(Boolean);
}

/** Ворота по тексту карточки: ссылок, @имён, названий изданий и стоп-слов быть не должно. */
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
    const head = fitText(model.headline, { width: W, maxLines: 3, maxSize: 62, minSize: 38, height: 215 });
    const cap = model.caption ? fitText(model.caption, { width: W, maxLines: 3, maxSize: 34, minSize: 24, height: 150, lh: 1.3 }) : null;
    body = `<div style="position:absolute;left:80px;top:230px;width:${W}px;height:${bigH}px;overflow:hidden">${lines(big, YELLOW, 900, 1.05)}</div>
<div style="position:absolute;left:80px;top:${230 + bigH}px;width:${W}px;height:${unit ? 190 : 140}px;overflow:hidden">${unit}${bars(model.number)}</div>
<div style="position:absolute;left:80px;top:790px;width:${W}px;height:215px;overflow:hidden">${lines(head, '#fff')}</div>
<div style="position:absolute;left:80px;top:1020px;width:${W}px;height:150px;overflow:hidden">${cap ? lines(cap, '#c9ccd1', 500, 1.3) : ''}</div>`;
  } else {
    const head = fitText(model.headline, { width: W, maxLines: 8, maxSize: 112, minSize: 48, height: 760 });
    body = `<div style="position:absolute;left:80px;top:330px;width:${W}px;height:850px;overflow:hidden">${lines(head, '#fff', 900)}<div style="margin-top:40px;height:14px;width:240px;background:${YELLOW}"></div></div>`;
  }
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}body{width:${CARD_W}px;height:${CARD_H}px;background:#222428;font-family:'Segoe UI','Arial',sans-serif;position:relative;overflow:hidden}</style></head><body><div style="position:absolute;left:0;top:0;width:${CARD_W}px;height:22px;background:${YELLOW}"></div>${chip}${body}${foot}</body></html>`;
}

// ───────── браузер ─────────

const WIN_PATHS = (env) => {
  const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
  return roots.flatMap((r) => [`${r}/Google/Chrome/Application/chrome.exe`, `${r}/Microsoft/Edge/Application/msedge.exe`]);
};
const OTHER_PATHS = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];

/** Путь к Chrome/Edge: CARD_BROWSER, потом стандартные места Windows. null — не найден. */
export function findBrowser({ env = process.env, exists = existsSync } = {}) {
  if (env.CARD_BROWSER) return exists(env.CARD_BROWSER) ? env.CARD_BROWSER : null;
  return [...WIN_PATHS(env), ...OTHER_PATHS].find((p) => exists(p)) ?? null;
}

const run = (cmd, args, timeout) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout, windowsHide: true }, (err) => (err ? reject(err) : resolve()));
});

const pngSize = (buf) => (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : null);

/**
 * Пост → PNG 1080×1350. post: { text, category?, time? }. Возвращает { file, sha256, width, height, layout, label }.
 * Нет браузера или не прошли ворота — CardError (code 'no-browser' | 'gate' | 'render'), без падения процесса.
 */
export async function renderCard(post, { outFile, config = DEFAULT_CONFIG, browser, exec = run, timeoutMs = 40000 } = {}) {
  const model = cardModel(post, { config });
  if (!model.headline) throw new CardError('empty', 'карточка: пустой текст поста');
  const g = gateCard(model);
  if (!g.ok) throw new CardError('gate', `карточка не прошла ворота: ${g.reasons.join('; ')}`);
  const exe = browser === undefined ? findBrowser() : browser;
  if (!exe) throw new CardError('no-browser', 'карточка: не найден Chrome/Edge — установите браузер или задайте путь в переменной CARD_BROWSER');
  if (!outFile) throw new CardError('render', 'карточка: не задан файл результата');
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
    if (!buf) throw new CardError('render', 'карточка: браузер не создал PNG 1080×1350');
    return { file: outFile, sha256: createHash('sha256').update(buf).digest('hex'), width: CARD_W, height: CARD_H, layout: model.layout, label: model.label };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
