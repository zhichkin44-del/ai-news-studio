/**
 * Разметка поста для Telegram (parse_mode HTML). Разрешены только <b>, <i>, <blockquote>, <blockquote expandable>;
 * всё остальное — обычный текст. Пост без разметки остаётся прежним (кроме экранирования & < >).
 */
const TAG_RE = /<\s*(\/?)\s*(b|i|blockquote)(\s+expandable)?\s*>/gi;
const ENTITY_RE = /&(?:amp|lt|gt|quot|#\d+|#x[0-9a-f]+);/iy;

/** Экранирует & < > в обычном тексте (готовые сущности &amp; &lt; &gt; &quot; не трогает). */
export function escapeText(s) {
  let out = '';
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '&') { ENTITY_RE.lastIndex = i; const m = ENTITY_RE.exec(str); out += m ? '&' : '&amp;'; }
    else if (c === '<') out += '&lt;';
    else if (c === '>') out += '&gt;';
    else out += c;
  }
  return out;
}

/**
 * Безопасный HTML для Telegram: разрешённые теги сохраняются (регистр и пробелы нормализуются),
 * лишние закрывающие отбрасываются, незакрытые закрываются, вложенные цитаты не открываются;
 * любые другие теги и случайные < > & экранируются.
 */
export function sanitizeHtml(text) {
  const src = String(text ?? '');
  const stack = [];
  let out = '';
  let last = 0;
  for (const m of src.matchAll(TAG_RE)) {
    out += escapeText(src.slice(last, m.index));
    last = m.index + m[0].length;
    const close = m[1] === '/';
    const name = m[2].toLowerCase();
    if (close) {
      const at = stack.lastIndexOf(name);
      if (at < 0) continue;
      while (stack.length > at) out += `</${stack.pop()}>`;
    } else if (name === 'blockquote' && stack.includes('blockquote')) {
      continue;
    } else if (name === 'blockquote' && stack.length) {
      while (stack.length) out += `</${stack.pop()}>`; // цитата внутри <b>/<i> не бывает: закрываем их
      stack.push(name);
      out += m[3] ? '<blockquote expandable>' : '<blockquote>';
    } else {
      stack.push(name);
      out += name === 'blockquote' && m[3] ? '<blockquote expandable>' : `<${name}>`;
    }
  }
  out += escapeText(src.slice(last));
  while (stack.length) out += `</${stack.pop()}>`;
  return out;
}

const decode = (s) => s.replace(/&(amp|lt|gt|quot);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"' }[e]));

/** Видимый текст: разрешённые теги сняты, сущности раскрыты. Для пустой разметки — тот же текст. */
export const visibleText = (text) => decode(sanitizeHtml(text).replace(/<\/?(?:b|i|blockquote)(?: expandable)?>/g, ''));

/** Видимый текст без слоя 3 (блок <blockquote>…</blockquote>) — то, что допустимо на карточке. */
export function cardText(text) {
  const noDetails = sanitizeHtml(text).replace(/<blockquote(?: expandable)?>[\s\S]*?<\/blockquote>/g, '');
  return visibleText(noDetails);
}

/** Есть ли в тексте разрешённая разметка. */
export const hasMarkup = (text) => new RegExp(TAG_RE.source, 'i').test(String(text ?? ''));
