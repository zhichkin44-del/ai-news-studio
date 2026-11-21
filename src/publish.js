import { isAbsolute, join } from 'node:path';
import { gate, MAX_LENGTH } from './gate.js';
import { sanitizeHtml, visibleText } from './markup.js';
import { watermarkCached, watermarkModeOf } from './watermark.js';

/** Start mode: only drafts approved by the owner are published; there is no auto-publishing. */
export const DEFAULT_CONFIG = { mode: 'только одобренные', max_per_hour: 3, min_gap_minutes: 20, retries: 2, retry_delay_ms: 2000, watermark: 'on' };

const HOUR = 3600_000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A network error is retried; a Bot API 4xx response (except 429) is not. */
export function isRetryable(err) {
  const s = err?.status ?? err?.error_code;
  if (s === undefined) return true;
  return s === 429 || s >= 500;
}

/**
 * Bot API request for a post: { text, image? } → { method, params }.
 * Caption/text ≤1024 characters; the picture goes via sendPhoto with the caption. No links or feed names in the text (the gate).
 */
export function formatPost(chat, post, { plain = false } = {}) {
  const raw = String(post?.text ?? '').trim();
  // The post's HTML markup (<b>, <i>, <blockquote [expandable]>) is cleaned; the rest is escaped. plain — a fallback without markup
  const text = plain ? visibleText(raw).trim() : sanitizeHtml(raw);
  const mode = plain ? {} : { parse_mode: 'HTML' };
  if (post?.image) return { method: 'sendPhoto', params: { chat_id: chat, photo: post.image, caption: text, ...mode } };
  return { method: 'sendMessage', params: { chat_id: chat, text, ...mode, disable_web_page_preview: true } };
}

/** Bot API could not parse the markup: 400 "can't parse entities". */
export const isParseError = (err) => (err?.status ?? err?.error_code) === 400 && /parse entities|unsupported start tag|can't find end/i.test(String(err?.message ?? err?.description ?? ''));

/**
 * Publish one post. send({ method, params }) → { message_id } (in production — the control panel's Bot API).
 * The gate.js gate is mandatory: if it fails, nothing is sent.
 * Returns { ok:true, message_id } | { ok:false, reason:'gate'|'config'|'error', reasons|error, retryable }.
 */
export async function publish({ chat, post, send, prefix = '', retries = DEFAULT_CONFIG.retries, retryDelayMs = DEFAULT_CONFIG.retry_delay_ms, sleep = wait }) {
  if (!chat) return { ok: false, reason: 'config', error: 'не задан news_channel_chat', retryable: false };
  if (typeof send !== 'function') return { ok: false, reason: 'config', error: 'не задан send', retryable: false };
  const g = gate({ body: String(post?.text ?? '') }, { maxLength: MAX_LENGTH - prefix.length });
  if (!g.ok) return { ok: false, reason: 'gate', reasons: g.reasons, retryable: false };
  // prefix — a service header («⚡️ СРОЧНО»): the gate checks the text without it, the length includes it
  const full = { ...post, text: prefix + String(post?.text ?? '').trim() };
  let req = formatPost(chat, full);
  let plain = false;
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await send(req);
      const id = res?.message_id ?? res?.result?.message_id;
      if (id === undefined || id === null) throw Object.assign(new Error('в ответе нет message_id'), { status: 502 });
      return { ok: true, message_id: id, ...(plain && { plain: true }) };
    } catch (e) {
      last = e;
      if (!plain && isParseError(e)) { plain = true; req = formatPost(chat, full, { plain: true }); attempt--; continue; } // markup not parsed — send without it, the post is not lost
      if (!isRetryable(e)) break;
      if (attempt < retries) await sleep(retryDelayMs * 2 ** attempt);
    }
  }
  return { ok: false, reason: 'error', error: String(last?.message ?? last), retryable: isRetryable(last) };
}

/**
 * One pass of the queue. Takes only «одобрен» (approved) drafts, in creation order; respects the hourly limit and the pause
 * after the previous publication. A post that fails the gate or is rejected by Bot API is skipped and stays «одобрен»;
 * a network error after retries stops the pass (the next pass will try again).
 * Duplicates: the status changes atomically «одобрен» → «опубликован» (published) with message_id.
 * The picture goes through the watermark before sendPhoto (watermark: 'off' in config — originals, for a personal feed).
 * Returns { published:[{id,message_id}], skipped:[{id,reason}], warnings:[{id,reason}], stopped: null|'лимит в час'|'пауза'|'сеть' }.
 */
export async function runQueue({ store, chat, send, config = {}, now = new Date(), sleep = wait, brand, baseDir = '', mark = (file, o) => watermarkCached(file, { ...o, config: { brand } }) }) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const out = { published: [], skipped: [], stopped: null, warnings: [] };
  if (cfg.mode !== DEFAULT_CONFIG.mode) { out.stopped = `режим не поддерживается: ${cfg.mode}`; return out; }
  const t = () => (now instanceof Date ? now : new Date(now()));
  for (const d of store.listDrafts({ status: 'одобрен' })) {
    const nowMs = t().getTime();
    const times = store.publishedTimes(new Date(nowMs - HOUR).toISOString()).map((x) => Date.parse(x));
    if (times.length >= cfg.max_per_hour) { out.stopped = 'лимит в час'; break; }
    const lastAll = store.publishedTimes().at(-1);
    if (lastAll && nowMs - Date.parse(lastAll) < cfg.min_gap_minutes * 60_000) { out.stopped = 'пауза'; break; }
    // Reservation BEFORE sending: if the «опубликован» mark is not written (database busy), the same post does not go out a second time (29.10: one post went out six times)
    if (!store.claimBroadcast('пост', d.id, { draftId: d.id }, t().toISOString())) { out.skipped.push({ id: d.id, reason: 'уже отправлялся' }); continue; }
    const img = store.getImage(d.id);
    // The mark goes on every picture of the public channel; if that fails, the post goes out as text and the original is not published
    // Image paths in the database are relative (data/images/…): the panel runs from its own folder, so the repository root comes in as baseDir
    let image = img?.file && baseDir && !isAbsolute(img.file) ? join(baseDir, img.file) : img?.file;
    if (image && watermarkModeOf(cfg) === 'on') {
      try { image = (await mark(image, { source: img.source })).file; } catch (e) { image = undefined; out.warnings.push({ id: d.id, reason: `водяной знак не нанесён, пост без картинки: ${e.message}` }); }
    }
    const r = await publish({ chat, post: { text: d.text, image }, send, retries: cfg.retries, retryDelayMs: cfg.retry_delay_ms, sleep });
    if (r.ok) {
      for (let i = 0; i < 6; i++) {
        try { store.markPublished(d.id, r.message_id, t().toISOString()); break; } catch (e) { if (i === 5) out.skipped.push({ id: d.id, reason: `отправлен, отметка не записалась: ${e.message}` }); else await sleep(1000 * (i + 1)); }
      }
      out.published.push({ id: d.id, message_id: r.message_id });
    } else {
      store.releaseBroadcast('пост', d.id); // not sent — the next pass will try again
      if (r.reason === 'config') { out.stopped = r.error; break; }
      if (r.retryable) { out.skipped.push({ id: d.id, reason: r.error }); out.stopped = 'сеть'; break; }
      out.skipped.push({ id: d.id, reason: r.reasons?.join('; ') ?? r.error });
    }
  }
  return out;
}
