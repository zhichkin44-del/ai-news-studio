import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect, loadSources } from './collect.js';
import { openStore } from './store.js';

const URL_RE = /https?:\/\/\S+|\bwww\.\S+/gi;

/** Текст без ссылок: для внутреннего материала Риты. */
export const stripLinks = (s) => String(s ?? '').replace(URL_RE, '').replace(/\s+/g, ' ').trim();

/**
 * События для Риты: без ссылок и названий лент, только число независимых источников.
 * events — из store.list(); items — из collect (для summary по ссылке).
 */
export function toEvalEvents(events, items) {
  const byLink = new Map(items.map((i) => [i.link, i]));
  return events.map((e) => ({
    id: e.id,
    title: stripLinks(e.title),
    summary: stripLinks(e.sources.map((s) => byLink.get(s.link)?.summary).filter(Boolean)[0] ?? ''),
    independent: e.independent_sources,
    score: e.score,
    status: e.status,
    reasons: e.reasons,
  }));
}

/** По `perStatus[статус]` событий, с разбросом тем: не берём события с общим первым словом заголовка. */
export function pick(events, perStatus) {
  const out = [];
  for (const [status, n] of Object.entries(perStatus)) {
    const seen = new Set();
    for (const e of events.filter((x) => x.status === status)) {
      const key = e.title.toLowerCase().split(/\s+/).find((w) => w.length > 4) ?? e.id;
      if (seen.has(key)) continue;
      seen.add(key);
      if (seen.size > n) break;
      out.push(e);
    }
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , outPath = 'docs/eval/events-2026-10-28.json', a = '4', b = '4', c = '4'] = process.argv;
  const { items } = await collect(await loadSources());
  const store = openStore();
  const all = store.list();
  store.close();
  const chosen = pick(all, { выпущено: Number(a), отобрано: Number(b), отклонено: Number(c) });
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(toEvalEvents(chosen, items), null, 2) + '\n', 'utf8');
  console.log(`${outPath}: ${chosen.length} событий`);
}
