/**
 * Post markup for Telegram (parse_mode HTML). Only <b>, <i>, <blockquote>, <blockquote expandable> are allowed;
 * everything else is plain text. A post without markup stays as it is (except escaping & < >).
 */
const TAG_RE = /<\s*(\/?)\s*(b|i|blockquote)(\s+expandable)?\s*>/gi;
const ENTITY_RE = /&(?:amp|lt|gt|quot|#\d+|#x[0-9a-f]+);/iy;

/** Escapes & < > in plain text (ready-made entities &amp; &lt; &gt; &quot; are left alone). */
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
 * Safe HTML for Telegram: allowed tags are kept (case and spaces normalized),
 * extra closing tags are dropped, unclosed ones are closed, nested quotes are not opened;
 * any other tags and stray < > & are escaped.
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
      while (stack.length) out += `</${stack.pop()}>`; // a quote inside <b>/<i> does not occur: close them
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

/** Visible text: allowed tags stripped, entities decoded. For text without markup — the same text. */
export const visibleText = (text) => decode(sanitizeHtml(text).replace(/<\/?(?:b|i|blockquote)(?: expandable)?>/g, ''));

/** Visible text without layer 3 (the <blockquote>…</blockquote> block) — what is allowed on the card. */
export function cardText(text) {
  const noDetails = sanitizeHtml(text).replace(/<blockquote(?: expandable)?>[\s\S]*?<\/blockquote>/g, '');
  return visibleText(noDetails);
}

/** Whether the text contains allowed markup. */
export const hasMarkup = (text) => new RegExp(TAG_RE.source, 'i').test(String(text ?? ''));
