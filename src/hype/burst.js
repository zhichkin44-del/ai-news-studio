import { readFileSync } from 'node:fs';
import { keys, stem } from '../cluster.js';

export const BURST_CONFIG = JSON.parse(readFileSync(new URL('./burst.config.json', import.meta.url), 'utf8'));

const HOUR = 3.6e6;
const aliasCache = new WeakMap();
function aliasMap(config) {
  if (!aliasCache.has(config)) aliasCache.set(config, new Map(Object.entries(config.aliases ?? {}).map(([en, ru]) => [stem(en), stem(ru)])));
  return aliasCache.get(config);
}

/** Ключевые слова записи (основы слов и числа ≥ 4 знаков); у сигналов в текст входит и summary — там заголовки связанных новостей. */
export function tokensOf(item, isSignal, config = BURST_CONFIG) {
  const alias = aliasMap(config);
  const out = new Set();
  for (const k of keys(isSignal ? `${item.title}. ${item.summary ?? ''}` : item.title).keys()) {
    const t = alias.get(k) ?? k;
    if (t.length >= 4 && !/^\d+$/.test(t)) out.add(t);
  }
  return out;
}

/** Время записи для скорости: когда это опубликовано (published), иначе когда радар увидел. */
export function timeOf(item, now) {
  const p = Date.parse(item.published ?? '');
  const f = Date.parse(item.first_seen ?? '');
  const t = Number.isFinite(p) ? p : f;
  return Number.isFinite(t) && t <= now + 10 * 60000 ? t : Number.isFinite(f) ? f : NaN;
}

const jaccard = (a, b) => {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter || 1);
};

/**
 * Всплеск: слово (основа) встретилось в последний час в min_recent+ записях и это в min_ratio раз чаще,
 * чем в среднем за час остальных суток; тема подтверждена записями min_types+ РАЗНЫХ видов
 * (media — ленты СМИ, reddit, trends, wikipedia, bluesky) за type_window_hours.
 * items: строки items { id, source, title, summary, published, first_seen }; kinds: id источника → вид сигнала (нет в карте = media).
 * known: заголовки событий, уже стоящих в топе: тема, чьи слова в них уже есть, не «новая».
 * Возвращает [{ tokens, ratio, recent, perHour, types, items, mediaItems, signalItems }], сильнейшие первыми.
 */
export function detectBursts(items, { now = Date.now(), kinds = {}, known = [], config = BURST_CONFIG } = {}) {
  const from = now - config.window_hours * HOUR;
  const recentFrom = now - config.recent_minutes * 60000;
  const typeFrom = now - config.type_window_hours * HOUR;
  // база моложе min_history_hours: ленты хранят лишь последние часы, «обычная скорость» занижена и любая тема выглядит всплеском
  const firstSeen = items.map((i) => Date.parse(i.first_seen ?? '')).filter(Number.isFinite);
  if (!firstSeen.length || now - Math.min(...firstSeen) < (config.min_history_hours ?? 0) * HOUR) return [];
  const rows = [];
  for (const it of items) {
    const t = timeOf(it, now);
    if (!Number.isFinite(t) || t < from) continue;
    const kind = kinds[it.source] ?? 'media';
    rows.push({ it, t, kind, tokens: tokensOf(it, kind !== 'media', config) });
  }
  const byToken = new Map();
  rows.forEach((r, i) => r.tokens.forEach((tok) => byToken.set(tok, [...(byToken.get(tok) ?? []), i])));

  const baseHours = Math.max(1, config.window_hours - config.recent_minutes / 60);
  const cands = [];
  for (const [token, idx] of byToken) {
    if (idx.length > config.max_df_share * rows.length && idx.length > 50) continue; // слишком общее слово
    const recent = idx.filter((i) => rows[i].t > recentFrom).length;
    if (recent < config.min_recent) continue;
    const perHour = (idx.length - recent) / baseHours;
    const ratio = recent / Math.max(perHour, config.floor_per_hour);
    if (ratio < config.min_ratio) continue;
    cands.push({ token, ratio, recent, perHour, set: new Set(idx.filter((i) => rows[i].t >= typeFrom)) });
  }
  cands.sort((a, b) => b.recent - a.recent || b.ratio - a.ratio || a.token.localeCompare(b.token));

  const topics = [];
  for (const c of cands) {
    const host = topics.find((tp) => jaccard(tp.set, c.set) >= config.merge_jaccard);
    if (host) {
      host.tokens.push(c.token);
      c.set.forEach((i) => host.set.add(i));
      host.ratio = Math.max(host.ratio, c.ratio);
      host.perHour = Math.min(host.perHour, c.perHour);
    } else {
      topics.push({ tokens: [c.token], set: new Set(c.set), ratio: c.ratio, perHour: c.perHour });
    }
  }

  const knownTokens = known.map((title) => tokensOf({ title }, false, config));
  const out = [];
  for (const tp of topics) {
    const mem = [...tp.set].map((i) => rows[i]);
    const types = [...new Set(mem.map((r) => r.kind))].sort();
    if (types.length < config.min_types || tp.tokens.length < (config.min_tokens ?? 1)) continue; // одно общее слово («вопрос», «высказал») — не тема
    const inTop = knownTokens.some((kt) => {
      const hit = tp.tokens.filter((t) => kt.has(t)).length;
      return hit >= Math.min(2, tp.tokens.length) && hit / tp.tokens.length >= 0.5;
    });
    if (inTop) continue;
    const recent = mem.filter((r) => r.t > recentFrom).length;
    out.push({
      tokens: tp.tokens, ratio: Math.round(tp.ratio * 10) / 10, recent, perHour: Math.round(tp.perHour * 100) / 100, types,
      items: mem.map((r) => r.it),
      mediaItems: mem.filter((r) => r.kind === 'media').map((r) => r.it),
      signalItems: mem.filter((r) => r.kind !== 'media').map((r) => r.it),
    });
  }
  return out.sort((a, b) => b.types.length * b.ratio - a.types.length * a.ratio || b.recent - a.recent).slice(0, config.max_events);
}

/** Заголовок события из всплеска: запись СМИ, в которой больше слов темы (раньше — выше), иначе сильнейший сигнал. */
export function burstTitle(burst, config = BURST_CONFIG) {
  const cover = (it, sig) => [...tokensOf(it, sig, config)].filter((t) => burst.tokens.includes(t)).length;
  const pick = (list, sig) => [...list].sort((a, b) => cover(b, sig) - cover(a, sig) || String(a.published ?? '').localeCompare(String(b.published ?? '')) || a.id.localeCompare(b.id))[0];
  const media = pick(burst.mediaItems, false);
  if (media) return media.title;
  const strength = (it) => { const m = typeof it.meta === 'string' ? JSON.parse(it.meta || '{}') : it.meta ?? {}; return m.score ?? m.reposts ?? m.traffic ?? m.views ?? 0; };
  return [...burst.signalItems].sort((a, b) => cover(b, true) - cover(a, true) || strength(b) - strength(a) || a.id.localeCompare(b.id))[0].title;
}
