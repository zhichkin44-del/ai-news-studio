export const MAX_LENGTH = 1024;

/** Издания и ленты из sources.json (названия и узнаваемые части). Согласованность проверяет тест. */
export const OUTLETS = [
  'BBC', 'Би-би-си', 'Русская служба', 'DW', 'Deutsche Welle', 'Дойче велле', 'Новости ООН', 'UN News',
  'Al Jazeera', 'Аль-Джазира', 'Гардиан', 'Guardian', 'NPR',
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
  const text = `${post?.title ?? ''}\n${post?.body ?? ''}`.trim();
  const reasons = [];
  if (!text) reasons.push('пустой пост');
  if (text.length > maxLength) reasons.push(`длиннее ${maxLength} знаков (${text.length})`);
  if (LINK_RES.some((re) => re.test(text))) reasons.push('ссылка или @юзернейм');
  const outlet = outlets.find((o) => hasWord(text, o));
  if (outlet) reasons.push(`упоминание издания: ${outlet}`);
  const stop = stopWords.find((w) => hasWord(text, w));
  if (stop) reasons.push(`стоп-слово: ${stop}`);
  return { ok: reasons.length === 0, reasons };
}
