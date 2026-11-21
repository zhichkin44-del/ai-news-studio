import { visibleText } from './markup.js';

/** Caption length under a picture in Telegram — by visible text (after the markup is parsed). */
export const MAX_LENGTH = 1024;

/** Outlets and feeds from sources.json (names and recognizable parts). A test checks consistency. */
export const OUTLETS = [
  // world feeds
  'BBC', 'Би-би-си', 'Русская служба', 'DW', 'Deutsche Welle', 'Дойче велле', 'Новости ООН', 'UN News',
  'Al Jazeera', 'Аль-Джазира', 'Гардиан', 'Guardian', 'NPR', 'Reuters', 'Associated Press', 'AP Top News',
  'The Verge', 'Wired', 'Bloomberg', 'Reddit', 'Wikipedia', 'Википедия', 'Google Trends', 'Bluesky',
  // Russian feeds
  'ТАСС', 'РИА Новости', 'РИА', 'Лента.ру', 'РБК', 'Медуза', 'Украинская правда', 'Медиазона',
  'Радио Свобода', 'Настоящее время', 'Фонтанка', 'Sports.ru', 'Интерфакс', 'Коммерсантъ',
  'Новая газета', 'Газета.ру', 'Чемпионат.com',
  // NASA, ESA and Nature are also news subjects, so they are banned only as feed names
  'Nature News', 'Science (AAAS) News', 'AAAS', 'Phys.org', 'ScienceDaily', 'N+1', 'Naked Science', 'NASA Breaking News', 'ESA Space News',
  'USGS Earthquakes', 'GDACS', 'Anthropic Status', 'OpenAI Status', 'GitHub Status', 'Google Cloud Status', 'NobelPrize.org',
  'France 24', 'NYT', 'ABC News', 'ESPN', 'Sky Sports', 'Variety', 'TMZ', 'E! Online', 'Space.com', 'New Scientist', 'Scientific American',
  'Engadget', 'CoinDesk', 'Cointelegraph', 'Life.ru', 'Московский комсомолец', 'Комсомольская правда', 'Российская газета', 'Ведомости', 'Спорт-Экспресс',
  'MIT Technology Review', 'Ars Technica', 'TechCrunch', 'Hacker News', 'Хабр', 'STAT News', 'CNBC',
];

/**
 * Stop-words (CHARTER §7, §9 and the 2026-10-28 decision): references to sources and
 * evaluative/clickbait words — they do not fit a neutral tone.
 */
export const STOP_WORDS = [
  'источник*', 'по данным', 'как сообщает', 'сообщает издание', 'ссылк*', 'читайте',
  'подписывайтесь', 'сенсаци*', 'шок', 'скандал*', 'эксклюзив*', 'срочно',
];

const LINK_RES = [
  /https?:\/\//i,
  /\bwww\./i,
  /\bt\.me\b/i,
  /(^|[^\w])@\w{2,}/u, // @usernames
  /\b[a-z0-9-]+\.(com|org|net|ru|uk|de|io|info)\b/i, // bare domains
];

/** Whole word; with an asterisk at the end — by word prefix (источник* → источники). */
const hasWord = (text, word) => {
  const stem = word.endsWith('*');
  const w = (stem ? word.slice(0, -1) : word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${w}${stem ? '' : '(?![\\p{L}\\p{N}])'}`, 'iu').test(text);
};

/**
 * Code gate for a finished post, no model involved. Pure function.
 * post: { title, body }. Returns { ok, reasons }.
 */
export function gate(post, { outlets = OUTLETS, stopWords = STOP_WORDS, maxLength = MAX_LENGTH } = {}) {
  const raw = `${post?.title ?? ''}\n${post?.body ?? ''}`.trim();
  const text = visibleText(raw).trim(); // allowed tags are counted neither in length nor for stop-words
  const reasons = [];
  if (!text) reasons.push('empty post');
  if (text.length > maxLength) reasons.push(`longer than ${maxLength} characters (${text.length})`);
  if (LINK_RES.some((re) => re.test(raw) || re.test(text))) reasons.push('link or @username'); // also in the raw markup: <a href> does not pass
  const outlet = outlets.find((o) => hasWord(text, o));
  if (outlet) reasons.push(`outlet mentioned: ${outlet}`);
  const stop = stopWords.find((w) => hasWord(text, w));
  if (stop) reasons.push(`stop-word: ${stop}`);
  return { ok: reasons.length === 0, reasons };
}
