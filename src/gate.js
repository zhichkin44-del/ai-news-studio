import { visibleText } from './markup.js';

/** Длина подписи под картинкой в Telegram — по видимому тексту (после разбора разметки). */
export const MAX_LENGTH = 1024;

/** Издания и ленты из sources.json (названия и узнаваемые части). Согласованность проверяет тест. */
export const OUTLETS = [
  // мировые ленты
  'BBC', 'Би-би-си', 'Русская служба', 'DW', 'Deutsche Welle', 'Дойче велле', 'Новости ООН', 'UN News',
  'Al Jazeera', 'Аль-Джазира', 'Гардиан', 'Guardian', 'NPR', 'Reuters', 'Associated Press', 'AP Top News',
  'The Verge', 'Wired', 'Bloomberg', 'Reddit', 'Wikipedia', 'Википедия', 'Google Trends', 'Bluesky',
  // российские ленты
  'ТАСС', 'РИА Новости', 'РИА', 'Лента.ру', 'РБК', 'Медуза', 'Украинская правда', 'Медиазона',
  'Радио Свобода', 'Настоящее время', 'Фонтанка', 'Sports.ru', 'Интерфакс', 'Коммерсантъ',
  'Новая газета', 'Газета.ру', 'Чемпионат.com',
  // NASA, ESA и Nature — ещё и предмет новостей, поэтому запрещены только как названия лент
  'Nature News', 'Science (AAAS) News', 'AAAS', 'Phys.org', 'ScienceDaily', 'N+1', 'Naked Science', 'NASA Breaking News', 'ESA Space News',
  'USGS Earthquakes', 'GDACS', 'Anthropic Status', 'OpenAI Status', 'GitHub Status', 'Google Cloud Status', 'NobelPrize.org',
  'France 24', 'NYT', 'ABC News', 'ESPN', 'Sky Sports', 'Variety', 'TMZ', 'E! Online', 'Space.com', 'New Scientist', 'Scientific American',
  'Engadget', 'CoinDesk', 'Cointelegraph', 'Life.ru', 'Московский комсомолец', 'Комсомольская правда', 'Российская газета', 'Ведомости', 'Спорт-Экспресс',
  'MIT Technology Review', 'Ars Technica', 'TechCrunch', 'Hacker News', 'Хабр', 'STAT News', 'CNBC',
];

/**
 * Стоп-слова (CHARTER §7, §9 и решение 2026-10-28): отсылки к источникам и
 * оценочные/кликбейтные слова — нейтральному тону они не подходят.
 */
export const STOP_WORDS = [
  'источник*', 'по данным', 'как сообщает', 'сообщает издание', 'ссылк*', 'читайте',
  'подписывайтесь', 'сенсаци*', 'шок', 'скандал*', 'эксклюзив*', 'срочно',
];

const LINK_RES = [
  /https?:\/\//i,
  /\bwww\./i,
  /\bt\.me\b/i,
  /(^|[^\w])@\w{2,}/u, // @юзернеймы
  /\b[a-z0-9-]+\.(com|org|net|ru|uk|de|io|info)\b/i, // голые домены
];

/** Слово целиком; со звёздочкой в конце — по началу слова (источник* → источники). */
const hasWord = (text, word) => {
  const stem = word.endsWith('*');
  const w = (stem ? word.slice(0, -1) : word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${w}${stem ? '' : '(?![\\p{L}\\p{N}])'}`, 'iu').test(text);
};

/**
 * Код-ворота готового поста, без модели. Чистая функция.
 * post: { title, body }. Возвращает { ok, reasons }.
 */
export function gate(post, { outlets = OUTLETS, stopWords = STOP_WORDS, maxLength = MAX_LENGTH } = {}) {
  const raw = `${post?.title ?? ''}\n${post?.body ?? ''}`.trim();
  const text = visibleText(raw).trim(); // разрешённые теги не считаются ни в длину, ни в стоп-слова
  const reasons = [];
  if (!text) reasons.push('empty post');
  if (text.length > maxLength) reasons.push(`longer than ${maxLength} characters (${text.length})`);
  if (LINK_RES.some((re) => re.test(raw) || re.test(text))) reasons.push('link or @username'); // и в сырой разметке: <a href> не пройдёт
  const outlet = outlets.find((o) => hasWord(text, o));
  if (outlet) reasons.push(`outlet mentioned: ${outlet}`);
  const stop = stopWords.find((w) => hasWord(text, w));
  if (stop) reasons.push(`stop-word: ${stop}`);
  return { ok: reasons.length === 0, reasons };
}
