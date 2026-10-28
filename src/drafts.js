import { fileURLToPath } from 'node:url';
import { openStore } from './store.js';

/** Черновики, ждущие одобрения, в виде для пульта. */
export function pendingDrafts(store) {
  return store.listDrafts({ status: 'ждёт одобрения' }).map((d) => ({
    id: d.id,
    event_id: d.event_id,
    style: d.style,
    text: d.text,
    score: d.score ?? null,
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const store = openStore(process.env.NEWS_DB);
  const list = pendingDrafts(store);
  store.close();
  if (process.argv.includes('--json')) console.log(JSON.stringify(list, null, 2));
  else console.log(list.length ? list.map((d) => `${d.id} [${d.style}] (${d.score}) ${d.text}`).join('\n') : 'пусто');
}
