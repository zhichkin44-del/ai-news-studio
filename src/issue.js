import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { collect, loadSources } from './collect.js';
import { select } from './select.js';
import { gate } from './gate.js';

export const DRAFT_PLACEHOLDER = '_[ЗАГЛУШКА: пересказ своими словами напишет роль «Автор» на следующем шаге]_';

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;

export const issueFileName = (d) => `${stamp(d)}.md`;
export const eventsFileName = (d) => `${stamp(d)}.events.json`;

/** Стабильный id кластера: по id записей-членов. */
export function clusterId(c) {
  return createHash('sha1').update(c.items.map((i) => i.id).sort().join('\n')).digest('hex').slice(0, 12);
}

/** Пост: заголовок + поле пересказа. Ни ссылок, ни источников. */
export const toPost = (c) => ({ title: c.title, body: DRAFT_PLACEHOLDER });

/**
 * Готовим выпуск: посты, прошедшие ворота, и служебные записи событий (все).
 * Статус подтверждения — HTML-комментарий вне текста поста.
 */
export function buildIssue(clusters, { date = new Date(), sources = [], errors = [], gateOpts } = {}) {
  const names = Object.fromEntries(sources.map((s) => [s.id, s.name]));
  const events = [];
  const lines = [`# Выпуск ${date.toISOString().slice(0, 16).replace('T', ' ')} UTC (тестовый канал)`, ''];
  let n = 0;
  for (const c of clusters) {
    const post = toPost(c);
    const g = gate(post, gateOpts);
    events.push({
      id: clusterId(c),
      title: c.title,
      status: c.status,
      independent_sources: c.sourceCount,
      time: c.newest,
      sources: c.sources.map((s) => ({ source: s.source, name: names[s.source] ?? s.source, link: s.link, published: s.published })),
      gate: g,
    });
    if (!g.ok) continue;
    n += 1;
    lines.push(`<!-- служебно: ${c.status}; событие ${clusterId(c)} -->`, `## ${n}. ${post.title}`, '', post.body, '');
  }
  if (!n) lines.push('_Новостей нет._', '');
  return {
    markdown: lines.join('\n') + '\n',
    events: { generated_at: date.toISOString(), events, feed_errors: errors },
  };
}

export async function makeIssue({ n = 10, outDir = 'out/test-channel', now = new Date(), loader, sources } = {}) {
  const list = sources ?? (await loadSources());
  const { items, errors } = await collect(list, loader ? { loader } : {});
  const clusters = select(items, { n, now: now.getTime(), groups: Object.fromEntries(list.map((s) => [s.id, s.group ?? s.id])) });
  const { markdown, events } = buildIssue(clusters, { date: now, sources: list, errors });
  const path = `${outDir}/${issueFileName(now)}`;
  const eventsPath = `${outDir}/${eventsFileName(now)}`;
  await mkdir(outDir, { recursive: true });
  await writeFile(path, markdown, 'utf8');
  await writeFile(eventsPath, JSON.stringify(events, null, 2) + '\n', 'utf8');
  return { path, eventsPath, clusters, errors };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { path, eventsPath, clusters, errors } = await makeIssue({ n: Number(process.env.ISSUE_N) || 10 });
  console.log(`Выпуск: ${path}; события: ${eventsPath}; новостей: ${clusters.length}; лент с ошибками: ${errors.length}`);
}
