import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gate } from './gate.js';
import { openStore } from './store.js';

/** Посты {id, style, text} из пакета → ворота → таблица drafts. id поста = id события. */
export function ingestPosts(store, posts) {
  if (!Array.isArray(posts)) throw new Error('ожидался массив постов');
  const rows = posts.map((p) => {
    const eventId = String(p?.id ?? '');
    const text = String(p?.text ?? '');
    if (!eventId || !store.get(eventId)) return { id: eventId || '?', ok: false, reasons: ['нет такого события'] };
    const g = gate({ title: '', body: text });
    const r = store.addDraft({ eventId, style: p.style, text, gateOk: g.ok, reasons: g.reasons });
    if (!r.saved) return { id: eventId, ok: true, reasons: [`черновик уже есть (${r.status})`], skipped: true };
    return { id: eventId, ok: g.ok, reasons: g.reasons };
  });
  return { rows, ok: rows.every((r) => r.ok) };
}

export const formatRows = (rows) =>
  rows.map((r) => `${r.id} — ${r.ok ? 'ok' : 'не ok'}${r.reasons.length ? ' — ' + r.reasons.join('; ') : ''}`).join('\n');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Использование: npm run ingest -- <папка-пакета>');
    process.exit(2);
  }
  let store;
  try {
    const posts = JSON.parse(await readFile(join(dir, 'posts.json'), 'utf8'));
    store = openStore(process.env.NEWS_DB);
    const { rows, ok } = ingestPosts(store, posts);
    console.log(formatRows(rows));
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`Ошибка: ${e.message}`);
    process.exit(2);
  }
}
