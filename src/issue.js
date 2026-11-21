import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { collect, loadSources } from './collect.js';
import { select } from './select.js';
import { gate } from './gate.js';
import { score, DEFAULT_CONFIG } from './score.js';
import { openStore, DEFAULT_DB } from './store.js';
import { isHype } from './hype/index.js';
import { historicalReason } from './history.js';

export const DRAFT_PLACEHOLDER = '_[ЗАГЛУШКА: пересказ своими словами напишет роль «Автор» на следующем шаге]_';

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;

export const issueFileName = (d) => `${stamp(d)}.md`;
export const eventsFileName = (d) => `${stamp(d)}.events.json`;

/** Stable cluster id: from the ids of its member records. */
export function clusterId(c) {
  return createHash('sha1').update(c.items.map((i) => i.id).sort().join('\n')).digest('hex').slice(0, 12);
}

/** Post: headline + retelling field. No links, no sources. */
export const toPost = (c) => ({ title: c.title, body: DRAFT_PLACEHOLDER });

export const firstSeenOf = (c) => c.items.map((i) => i.published).filter(Boolean).sort()[0] ?? null;

export const sourceMetaOf = (list) => Object.fromEntries(list.map((s) => [s.id, { category: s.category, authority: !!s.authority, lang: s.lang }]));

const CATEGORY_ORDER = ['science', 'space', 'health', 'tech', 'war', 'russia', 'accidents', 'celebrity', 'sport', 'society', 'world', 'economy']; // on a tie in votes; the general economic feed does not override the world feed

/** Event category — the one most feeds of its cluster belong to; the «leading source» flag — at least one such feed. */
export function eventMeta(c, sourceMeta = {}) {
  const ms = c.sources.map((s) => sourceMeta[s.source]).filter(Boolean);
  const votes = (k) => ms.filter((m) => m.category === k).length;
  const category = CATEGORY_ORDER.filter((k) => votes(k)).sort((a, b) => votes(b) - votes(a))[0];
  const lang = ms.filter((m) => m.lang);
  return { category, authority: ms.some((m) => m.authority), ...(lang.length && { ru: lang.some((m) => m.lang === 'ru') }) };
}

/**
 * Decision on an event: gate + score → status and reason.
 * A single-source event above the threshold is not published — it waits for the owner.
 */
export function decide(c, { now = Date.now(), scoreConfig, gateOpts, sourceMeta } = {}) {
  const post = toPost(c);
  const g = gate(post, gateOpts);
  const cfg = scoreConfig ?? DEFAULT_CONFIG;
  const sc = score(
    { title: c.title, summary: c.items.map((i) => i.summary).join(' '), firstSeen: firstSeenOf(c), independentSources: c.sourceCount, ...eventMeta(c, sourceMeta), times: c.items.map((i) => i.published), ...(c.hype && { hype: c.hype }) },
    { now, config: cfg },
  );
  let status, reason;
  const hist = historicalReason(c.title);
  if (hist) [status, reason] = ['отклонено', `историческая справка (${hist}), не новость`];
  else if (!g.ok) [status, reason] = ['отклонено', `ворота: ${g.reasons.join('; ')}`];
  else if (sc.score < cfg.thresholds.publish) [status, reason] = ['отклонено', `оценка ${sc.score} ниже порога ${cfg.thresholds.publish}`];
  else if (sc.single) [status, reason] = ['отобрано', 'одно-источниковое: ждёт одобрения владельца'];
  else [status, reason] = ['выпущено', sc.acute ? 'острое: нужно одобрение владельца' : null];
  return { post, gate: g, sc, status, reason };
}

/**
 * Preparing an issue: the posts are events above the threshold that passed the gate, are not single-source
 * and are not yet published; the rest stay in the events and the store with their status and reason.
 */
export function buildIssue(clusters, { date = new Date(), sources = [], errors = [], gateOpts, scoreConfig, store, sourceMeta } = {}) {
  const cfg = scoreConfig ?? DEFAULT_CONFIG;
  const names = Object.fromEntries(sources.map((s) => [s.id, s.name]));
  const events = [];
  const posted = [];
  for (const c of clusters) {
    const d = decide(c, { now: date.getTime(), scoreConfig: cfg, gateOpts, sourceMeta });
    const ev = {
      id: clusterId(c),
      title: c.title,
      status: d.status,
      status_reason: d.reason,
      score: d.sc.score,
      score_reasons: d.sc.reasons,
      needs_owner: d.sc.needsOwner,
      verification: c.status,
      independent_sources: c.sourceCount,
      time: c.newest,
      sources: c.sources.map((s) => ({ source: s.source, name: names[s.source] ?? s.source, link: s.link, published: s.published })),
      gate: d.gate,
    };
    if (store) {
      const r = store.upsert(
        { id: ev.id, title: c.title, firstSeen: firstSeenOf(c), independentSources: c.sourceCount, score: d.sc.score, reasons: d.sc.reasons, needsOwner: d.sc.needsOwner, sources: ev.sources },
        date.toISOString(),
      );
      ev.id = r.id;
      if (r.status === 'выпущено') { // already in a previous issue: do not create a duplicate
        ev.status = 'выпущено';
        ev.status_reason = 'уже выпущено ранее';
        events.push(ev);
        continue;
      }
      store.setStatus(r.id, d.status, d.reason, date.toISOString());
    }
    events.push(ev);
    if (d.status === 'выпущено') posted.push({ c, d, id: ev.id });
  }
  const lines = [`# Выпуск ${date.toISOString().slice(0, 16).replace('T', ' ')} UTC (тестовый канал)`, ''];
  posted.sort((a, b) => b.d.sc.score - a.d.sc.score).forEach(({ c, d, id }, i) => {
    const urgent = d.sc.score >= cfg.thresholds.urgent ? '; срочно' : '';
    const owner = d.sc.acute ? '; на одобрение владельца' : '';
    lines.push(`<!-- служебно: ${c.status}; оценка ${d.sc.score}${urgent}${owner}; событие ${id} -->`, `## ${i + 1}. ${d.post.title}`, '', d.post.body, '');
  });
  if (!posted.length) lines.push('_Новостей нет._', '');
  return {
    markdown: lines.join('\n') + '\n',
    events: { generated_at: date.toISOString(), events, feed_errors: errors },
  };
}

export async function makeIssue({ n = 30, outDir = 'out/test-channel', now = new Date(), loader, sources, dbPath = DEFAULT_DB, scoreConfig } = {}) {
  const list = sources ?? (await loadSources());
  const { items, errors } = await collect(list.filter((s) => !isHype(s)), loader ? { loader } : {}); // hype signals are not news; select handles them
  const clusters = select(items, { n, now: now.getTime(), groups: Object.fromEntries(list.map((s) => [s.id, s.group ?? s.id])) });
  const store = openStore(dbPath);
  let built;
  try {
    built = buildIssue(clusters, { date: now, sources: list, errors, store, scoreConfig, sourceMeta: sourceMetaOf(list) });
  } finally {
    store.close();
  }
  const { markdown, events } = built;
  const path = `${outDir}/${issueFileName(now)}`;
  const eventsPath = `${outDir}/${eventsFileName(now)}`;
  await mkdir(outDir, { recursive: true });
  await writeFile(path, markdown, 'utf8');
  await writeFile(eventsPath, JSON.stringify(events, null, 2) + '\n', 'utf8');
  return { path, eventsPath, clusters, events: events.events, errors };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { path, eventsPath, events, errors } = await makeIssue({ n: Number(process.env.ISSUE_N) || 30 });
  const by = (s) => events.filter((e) => e.status === s).length;
  console.log(`Issue: ${path}; events: ${eventsPath}; events: ${events.length} (published ${by('выпущено')}, selected ${by('отобрано')}, rejected ${by('отклонено')}); feeds with errors: ${errors.length}`);
  for (const e of [...events].sort((a, b) => b.score - a.score).slice(0, 5)) console.log(`${e.title} — ${e.score} — ${e.status}`);
}
