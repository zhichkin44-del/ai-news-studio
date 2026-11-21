import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.js';
import { stripLinks } from './export-eval.js';

export const SINGLE_MIN_SCORE = 70;
export const BATCHES_DIR = 'data/batches';

/** Подходит ли событие в пакет: 2+ источников; одно-источниковое — только без needsOwner и с оценкой ≥ 70. */
export function eligible(e) {
  if (e.independent_sources >= 2) return true;
  return !e.needs_owner && (e.score ?? 0) >= SINGLE_MIN_SCORE;
}

/** События «отобрано» без черновика, не больше max, лучшие по оценке — в формате docs/eval/events-*.json. */
export function pickEvents(store, max = 6) {
  return store
    .list({ status: 'отобрано' })
    .filter((e) => eligible(e) && !store.hasDraft(e.id))
    .slice(0, max)
    .map((e) => ({
      id: e.id,
      title: stripLinks(e.title),
      summary: stripLinks(store.summaryOf(e.id)),
      independent: e.independent_sources,
      score: e.score,
      status: e.status,
      reasons: e.reasons,
    }));
}

export const README = (n) => `# Пакет для Риты: ${n} событий
1. Прочитай \`events.json\`: id, title, summary, independent (число независимых источников), score, reasons.
2. Правила отбора и стили — \`docs/methodology/*\` (только чтение). Для одного источника — осторожнее с цифрами и именами.
3. На каждое событие — один пост в три слоя (\`docs/methodology/04-mass-audience.md\`, раздел 7): \`<b>заголовок</b>\`, суть, \`<b>Что это значит:</b>\`/\`<b>Что сейчас:</b>\`, подробности в \`<blockquote expandable>\`. Теги только \`<b>\`, \`<i>\`, \`<blockquote>\`; в тексте нет ссылок, @юзернеймов, названий изданий, источников; видимый текст не длиннее 1024 знаков.
4. Запиши \`posts.json\` рядом с этим файлом: массив \`{"id": "<id события>", "style": "<стиль>", "text": "<текст>"}\`.
5. Проверь: \`npm run check-posts -- <папка>/posts.json\`; исправь не прошедшие.
6. Сдай: \`npm run ingest -- <папка>\`.
`;

export const stamp = (d = new Date()) => d.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');

/** Создаёт пакет. Возвращает путь к папке или null, если брать нечего. */
export async function makeBatch({ dbPath, max = 6, dir = BATCHES_DIR, now = new Date() } = {}) {
  const store = openStore(dbPath);
  let events;
  try {
    events = pickEvents(store, max);
  } finally {
    store.close();
  }
  if (!events.length) return null;
  const folder = join(dir, stamp(now));
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'events.json'), JSON.stringify(events, null, 2) + '\n', 'utf8');
  await writeFile(join(folder, 'README.md'), README(events.length), 'utf8');
  return folder;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--max');
  const max = i >= 0 ? Number(args[i + 1]) : 6;
  if (!Number.isInteger(max) || max < 1) {
    console.error('Usage: npm run batch -- [--max N]');
    process.exit(2);
  }
  const folder = await makeBatch({ max, dbPath: process.env.NEWS_DB, dir: process.env.NEWS_BATCHES });
  console.log(folder ?? 'empty');
}
