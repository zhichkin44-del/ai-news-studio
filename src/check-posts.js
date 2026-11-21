import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gate } from './gate.js';

/** Прогон постов {id, style, text} через ворота. Возвращает строки и общий итог. */
export function checkPosts(posts) {
  if (!Array.isArray(posts)) throw new Error('expected an array of posts');
  const rows = posts.map((p) => {
    const g = gate({ title: '', body: p?.text ?? '' });
    return { id: p?.id ?? '?', ok: g.ok, reasons: g.reasons };
  });
  return { rows, ok: rows.every((r) => r.ok) };
}

export const formatRows = (rows) =>
  rows.map((r) => `${r.id} — ${r.ok ? 'ok' : 'не ok'}${r.reasons.length ? ' — ' + r.reasons.join('; ') : ''}`).join('\n');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: npm run check-posts -- <file.json>');
    process.exit(2);
  }
  try {
    const { rows, ok } = checkPosts(JSON.parse(await readFile(file, 'utf8')));
    console.log(formatRows(rows));
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`Ошибка: ${e.message}`);
    process.exit(2);
  }
}
