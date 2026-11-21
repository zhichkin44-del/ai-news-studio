import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSources } from './collect.js';
import { fetchSource, isHype } from './hype/index.js';
import { openStore, DEFAULT_DB } from './store.js';

export const INTERVAL_SEC = 120;
export const ERROR_LOG = 'data/radar-errors.log';

function logError(logPath, source, error, ts) {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify({ ts, source, error }) + '\n', 'utf8');
}

/**
 * One pass over the feeds. An error or empty response from one feed goes to the log and to polls; the others continue.
 * Records from a feed's first successful poll are marked baseline (accumulated history, not "fresh").
 */
export async function pollOnce(allSources, { store, loader = fetchSource, logPath = ERROR_LOG, now = () => new Date() } = {}) {
  // hype sources have their own rhythm (every_min): between polls they stay silent and are not written to polls
  const sources = allSources.filter((s) => {
    const last = s.every_min && store.lastPollTs(s.id);
    return !last || now().getTime() - Date.parse(last) >= s.every_min * 60000;
  });
  const results = await Promise.allSettled(sources.map((s) => loader(s)));
  const summary = [];
  results.forEach((r, i) => {
    const src = sources[i];
    const ts = now().toISOString();
    let error = null;
    let items = [];
    if (r.status === 'rejected') error = String(r.reason?.message ?? r.reason);
    // empty hype signals are normal (Reddit answered 429, Wikipedia has no sharp rise)
    else if (!r.value.length && !isHype(src)) error = 'empty response: 0 items';
    else items = r.value;
    let added = 0;
    try {
      if (items.length) added = store.addItems(items, { now: ts, baseline: !store.hasItems(src.id) });
    } catch (e) {
      error = `база: ${e.message}`;
    }
    store.recordPoll(src.id, { ok: !error, count: items.length, error }, ts);
    if (error) logError(logPath, src.id, error, ts);
    summary.push({ source: src.id, ok: !error, count: items.length, added, error });
  });
  return summary;
}

/** Loop: a pass, a pause of intervalSec, and so on until forSec expires (or forever). once — a single pass. */
export async function runRadar({ sources, store, loader, logPath, intervalSec = INTERVAL_SEC, forSec = null, once = false, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), clock = () => Date.now(), onPass } = {}) {
  const started = clock();
  let passes = 0;
  for (;;) {
    const summary = await pollOnce(sources, { store, loader, logPath, now: () => new Date(clock()) });
    passes++;
    onPass?.(summary, passes);
    if (once) break;
    if (forSec != null && clock() - started + intervalSec * 1000 >= forSec * 1000) break;
    await sleep(intervalSec * 1000);
  }
  return passes;
}

export function parseArgs(argv) {
  const out = { once: false, forSec: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--once') out.once = true;
    else if (argv[i] === '--for') {
      const n = Number(argv[++i]);
      if (!(n > 0)) throw new Error('--for requires a number of seconds > 0');
      out.forSec = n;
    } else throw new Error(`unknown flag: ${argv[i]}`);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const sources = await loadSources();
  const store = openStore(DEFAULT_DB);
  try {
    await runRadar({
      sources, store, ...args,
      onPass: (summary, n) => console.log(`${new Date().toISOString()} pass ${n}: new ${summary.reduce((a, s) => a + s.added, 0)}, feeds with errors ${summary.filter((s) => !s.ok).length}`),
    });
  } finally {
    store.close();
  }
}
