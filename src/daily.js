import { DEFAULT_CONFIG as SCORE_CONFIG } from './score.js';
import { gate, MAX_LENGTH } from './gate.js';
import { publish } from './publish.js';
import { pickDiverse, peakOf, sectionOf } from './diversity.js';

const MIN = 60_000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const BREAKING_HEAD = '⚡️ СРОЧНО\n\n';
const LIVE_DRAFT = new Set(['ждёт одобрения', 'одобрен', 'опубликован']);

/** Сетка дня из score.config.json → daily; переопределяется аргументом. */
export const dailyConfig = (over = {}) => {
  const base = SCORE_CONFIG.daily ?? {};
  return { ...base, ...over, breaking: { ...(base.breaking ?? {}), ...(over.breaking ?? {}) } };
};

/** Календарный день по МСК ('YYYY-MM-DD') для момента ms. */
export const mskDay = (ms, tz = 3) => new Date(ms + tz * 3600_000).toISOString().slice(0, 10);

/** Момент (мс UTC) «HH:MM» по МСК в календарный день day. */
export function slotTime(day, hhmm, tz = 3) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return Date.parse(`${day}T00:00:00Z`) + (h * 60 + (m || 0)) * MIN - tz * 3600_000;
}

/** Какой дайджест пора выпускать: { kind:'утро'|'вечер', day, slot } | null. Окно — от времени дайджеста до +grace_minutes. */
export function dueDigest(nowMs, cfg = dailyConfig()) {
  const day = mskDay(nowMs, cfg.tz_hours);
  for (const [kind, hhmm] of [['вечер', cfg.evening], ['утро', cfg.morning]]) {
    const slot = slotTime(day, hhmm, cfg.tz_hours);
    if (nowMs >= slot && nowMs < slot + cfg.grace_minutes * MIN) return { kind, day, slot };
  }
  return null;
}

/** Первая фраза черновика (вторая — если первая короткая); без эмодзи-шапок, переносов и кавычек-ёлочек по краям. */
export function leadOf(text, max = 200) {
  const flat = String(text ?? '').replace(/[\u{1F300}-\u{1FAFF}☀-➿️]/gu, '').replace(/\s+/g, ' ').trim();
  const sentences = flat.match(/.+?[.!?…]+(?=\s|$)|.+$/gu)?.map((s) => s.trim()).filter(Boolean) ?? [];
  let out = sentences[0] ?? '';
  if (out.length < 70 && sentences[1] && `${out} ${sentences[1]}`.length <= max) out = `${out} ${sentences[1]}`;
  if (out.length > max) out = `${out.slice(0, max).replace(/\s+\S*$/, '')}…`;
  return out;
}

/** Подходящие события: top_of_day, живой черновик, окно по first_seen, пункт проходит ворота; квота по темам. */
function pickItems(store, { from, to, limit, perGroup, skip = new Set() }) {
  const drafts = new Map(store.listDrafts().filter((d) => LIVE_DRAFT.has(d.status)).map((d) => [d.event_id, d]));
  const cands = [];
  for (const e of store.list()) {
    const t = Date.parse(e.first_seen ?? '');
    const d = drafts.get(e.id);
    if (!e.top_of_day || !d || skip.has(e.id) || !(t >= from && t < to) || e.status === 'отклонено') continue;
    const line = leadOf(d.text);
    if (!line || !gate({ body: line }).ok) continue;
    cands.push({ ...e, line });
  }
  return pickDiverse(cands, { limit, perGroup, minOutside: 0, minScore: 0, scoreOf: peakOf });
}

/** Текст дайджеста: пронумерованные пункты, в ≤1024 знака (лишние пункты с конца отбрасываются). */
export function buildDigest(kind, items, { minItems = 3 } = {}) {
  const head = kind === 'утро' ? 'Главное за ночь' : 'Итог дня';
  const tail = (list) => {
    if (kind !== 'вечер') return '';
    const topics = [...new Set(list.map(sectionOf))].slice(0, 3).join(', ');
    return `\n\nЧто следить завтра: развитие событий по темам — ${topics}.`;
  };
  for (let n = items.length; n >= minItems; n--) {
    const list = items.slice(0, n);
    const text = `${head}\n\n${list.map((e, i) => `${i + 1}. ${e.line}`).join('\n')}${tail(list)}`;
    if (text.length <= MAX_LENGTH && gate({ body: text }).ok) return { text, items: list };
  }
  return null;
}

/**
 * Дайджест по сетке дня: утро (08:00 МСК) и вечер (21:00 МСК), по одному в сутки каждый.
 * Идёт мимо часового лимита обычных постов, но через publish() (ворота) и с бронью (kind, день) — дубля не будет.
 * Меньше min_items подходящих — не публикуется. Возвращает { published, kind?, day?, message_id?, reason? }.
 */
export async function runDaily({ store, chat, send, config = {}, now = new Date(), sleep = wait }) {
  const cfg = dailyConfig(config);
  const nowMs = (now instanceof Date ? now : new Date(typeof now === 'function' ? now() : now)).getTime();
  const due = dueDigest(nowMs, cfg);
  if (!due) return { published: false, reason: 'не время дайджеста' };
  const { kind, day, slot } = due;
  if (store.hasBroadcast(kind, day)) return { published: false, kind, day, reason: 'уже выпущен за сутки' };
  const morning = kind === 'утро';
  const done = new Set(store.broadcasts({ day }).flatMap((b) => b.event_ids)); // вечером не повторяем утреннее
  const items = pickItems(store, {
    from: morning ? slot - cfg.morning_window_hours * 3600_000 : slotTime(day, '00:00', cfg.tz_hours),
    to: slot + 1,
    limit: morning ? cfg.morning_items : cfg.evening_items,
    perGroup: cfg.per_group,
    skip: done,
  });
  const built = buildDigest(kind, items, { minItems: cfg.min_items });
  if (!built) return { published: false, kind, day, reason: `меньше ${cfg.min_items} подходящих пунктов` };
  if (!store.claimBroadcast(kind, day, { day, eventIds: built.items.map((e) => e.id) }, new Date(nowMs).toISOString())) {
    return { published: false, kind, day, reason: 'уже выпущен за сутки' };
  }
  const r = await publish({ chat, post: { text: built.text }, send, sleep });
  if (!r.ok) {
    store.releaseBroadcast(kind, day);
    return { published: false, kind, day, reason: r.error ?? r.reasons?.join('; ') };
  }
  store.finishBroadcast(kind, day, r.message_id, new Date(nowMs).toISOString());
  return { published: true, kind, day, message_id: r.message_id, items: built.items.map((e) => e.id) };
}

/**
 * «⚡️ СРОЧНО»: breaking=1, независимых издателей ≥ min_sources (3), одобренный черновик, событие свежее.
 * Вне часовой очереди; не чаще раза в gap_minutes и не более per_day в сутки по МСК.
 * Возвращает { published:[{id,message_id}], skipped:[{id,reason}], stopped: null|'пауза'|'лимит в сутки'|'сеть' }.
 */
export async function runBreaking({ store, chat, send, config = {}, now = new Date(), sleep = wait }) {
  const cfg = dailyConfig(config);
  const b = cfg.breaking;
  const out = { published: [], skipped: [], stopped: null };
  const t = () => (now instanceof Date ? now : new Date(typeof now === 'function' ? now() : now)).getTime();
  const drafts = new Map(store.listDrafts({ status: 'одобрен' }).map((d) => [d.event_id, d]));
  const events = store.list().filter((e) => e.breaking && e.independent_sources >= b.min_sources && drafts.has(e.id))
    .sort((x, y) => String(x.first_seen).localeCompare(String(y.first_seen)));
  for (const e of events) {
    const nowMs = t();
    const age = nowMs - Date.parse(e.first_seen ?? '');
    if (!(age <= b.max_age_minutes * MIN)) { out.skipped.push({ id: e.id, reason: 'устарело' }); continue; }
    const sent = store.broadcasts({ kind: 'срочно', since: new Date(nowMs - 48 * 3600_000).toISOString() });
    const last = sent.at(-1);
    if (last && nowMs - Date.parse(last.published_at) < b.gap_minutes * MIN) { out.stopped = 'пауза'; break; }
    const today = mskDay(nowMs, cfg.tz_hours);
    if (sent.filter((r) => mskDay(Date.parse(r.published_at), cfg.tz_hours) === today).length >= b.per_day) { out.stopped = 'лимит в сутки'; break; }
    const d = drafts.get(e.id);
    if (!store.claimBroadcast('срочно', d.id, { day: today, draftId: d.id, eventIds: [e.id] }, new Date(nowMs).toISOString())) continue;
    const img = store.getImage(d.id);
    const r = await publish({ chat, post: { text: d.text, image: img?.file }, prefix: BREAKING_HEAD, send, sleep });
    if (!r.ok) {
      store.releaseBroadcast('срочно', d.id);
      if (r.reason === 'config') { out.stopped = r.error; break; }
      out.skipped.push({ id: d.id, reason: r.error ?? r.reasons?.join('; ') });
      if (r.retryable) { out.stopped = 'сеть'; break; }
      continue;
    }
    const at = new Date(t()).toISOString();
    store.markPublished(d.id, r.message_id, at);
    store.finishBroadcast('срочно', d.id, r.message_id, at);
    out.published.push({ id: d.id, message_id: r.message_id });
  }
  return out;
}
