import { gate, MAX_LENGTH } from './gate.js';
import { sanitizeHtml, visibleText } from './markup.js';

/** Режим старта: публикуются только черновики, одобренные владельцем; автопубликации нет. */
export const DEFAULT_CONFIG = { mode: 'только одобренные', max_per_hour: 3, min_gap_minutes: 20, retries: 2, retry_delay_ms: 2000 };

const HOUR = 3600_000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Сетевая ошибка — повторяем; ответ Bot API 4xx (кроме 429) — нет. */
export function isRetryable(err) {
  const s = err?.status ?? err?.error_code;
  if (s === undefined) return true;
  return s === 429 || s >= 500;
}

/**
 * Запрос к Bot API по посту: { text, image? } → { method, params }.
 * Подпись/текст ≤1024 знаков, картинка — sendPhoto с подписью. Ссылок и названий лент в тексте нет (ворота).
 */
export function formatPost(chat, post, { plain = false } = {}) {
  const raw = String(post?.text ?? '').trim();
  // HTML-разметка поста (<b>, <i>, <blockquote [expandable]>) чистится; остальное экранируется. plain — запасной вариант без разметки
  const text = plain ? visibleText(raw).trim() : sanitizeHtml(raw);
  const mode = plain ? {} : { parse_mode: 'HTML' };
  if (post?.image) return { method: 'sendPhoto', params: { chat_id: chat, photo: post.image, caption: text, ...mode } };
  return { method: 'sendMessage', params: { chat_id: chat, text, ...mode, disable_web_page_preview: true } };
}

/** Bot API не смог разобрать разметку: 400 «can't parse entities». */
export const isParseError = (err) => (err?.status ?? err?.error_code) === 400 && /parse entities|unsupported start tag|can't find end/i.test(String(err?.message ?? err?.description ?? ''));

/**
 * Опубликовать один пост. send({ method, params }) → { message_id } (в бою — Bot API пульта).
 * Ворота gate.js обязательны: не прошёл — ничего не отправляется.
 * Возвращает { ok:true, message_id } | { ok:false, reason:'gate'|'config'|'error', reasons|error, retryable }.
 */
export async function publish({ chat, post, send, prefix = '', retries = DEFAULT_CONFIG.retries, retryDelayMs = DEFAULT_CONFIG.retry_delay_ms, sleep = wait }) {
  if (!chat) return { ok: false, reason: 'config', error: 'не задан news_channel_chat', retryable: false };
  if (typeof send !== 'function') return { ok: false, reason: 'config', error: 'не задан send', retryable: false };
  const g = gate({ body: String(post?.text ?? '') }, { maxLength: MAX_LENGTH - prefix.length });
  if (!g.ok) return { ok: false, reason: 'gate', reasons: g.reasons, retryable: false };
  // prefix — служебная шапка («⚡️ СРОЧНО»): ворота проверяют текст без неё, длина — вместе с ней
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
      if (!plain && isParseError(e)) { plain = true; req = formatPost(chat, full, { plain: true }); attempt--; continue; } // разметка не разобрана — шлём без неё, пост не теряем
      if (!isRetryable(e)) break;
      if (attempt < retries) await sleep(retryDelayMs * 2 ** attempt);
    }
  }
  return { ok: false, reason: 'error', error: String(last?.message ?? last), retryable: isRetryable(last) };
}

/**
 * Один проход очереди. Берёт только «одобрен» (по порядку создания), соблюдает лимит в час и паузу
 * после предыдущей публикации. Пост, не прошедший ворота или отвергнутый Bot API, пропускается и остаётся «одобрен»;
 * сетевая ошибка после повторов останавливает проход (следующий проход попробует снова).
 * Дубли: статус меняется атомарно «одобрен» → «опубликован» с message_id.
 * Возвращает { published:[{id,message_id}], skipped:[{id,reason}], stopped: null|'лимит в час'|'пауза'|'сеть' }.
 */
export async function runQueue({ store, chat, send, config = {}, now = new Date(), sleep = wait }) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const out = { published: [], skipped: [], stopped: null };
  if (cfg.mode !== DEFAULT_CONFIG.mode) { out.stopped = `режим не поддерживается: ${cfg.mode}`; return out; }
  const t = () => (now instanceof Date ? now : new Date(now()));
  for (const d of store.listDrafts({ status: 'одобрен' })) {
    const nowMs = t().getTime();
    const times = store.publishedTimes(new Date(nowMs - HOUR).toISOString()).map((x) => Date.parse(x));
    if (times.length >= cfg.max_per_hour) { out.stopped = 'лимит в час'; break; }
    const lastAll = store.publishedTimes().at(-1);
    if (lastAll && nowMs - Date.parse(lastAll) < cfg.min_gap_minutes * 60_000) { out.stopped = 'пауза'; break; }
    // Бронь ДО отправки: если отметка «опубликован» не запишется (база занята), тот же пост не уйдёт второй раз (29.10: один пост шесть раз)
    if (!store.claimBroadcast('пост', d.id, { draftId: d.id }, t().toISOString())) { out.skipped.push({ id: d.id, reason: 'уже отправлялся' }); continue; }
    const img = store.getImage(d.id);
    const r = await publish({ chat, post: { text: d.text, image: img?.file }, send, retries: cfg.retries, retryDelayMs: cfg.retry_delay_ms, sleep });
    if (r.ok) {
      for (let i = 0; i < 6; i++) {
        try { store.markPublished(d.id, r.message_id, t().toISOString()); break; } catch (e) { if (i === 5) out.skipped.push({ id: d.id, reason: `отправлен, отметка не записалась: ${e.message}` }); else await sleep(1000 * (i + 1)); }
      }
      out.published.push({ id: d.id, message_id: r.message_id });
    } else {
      store.releaseBroadcast('пост', d.id); // не ушло — следующий проход попробует снова
      if (r.reason === 'config') { out.stopped = r.error; break; }
      if (r.retryable) { out.skipped.push({ id: d.id, reason: r.error }); out.stopped = 'сеть'; break; }
      out.skipped.push({ id: d.id, reason: r.reasons?.join('; ') ?? r.error });
    }
  }
  return out;
}
