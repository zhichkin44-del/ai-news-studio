import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const STATUSES = ['новое', 'отобрано', 'отклонено', 'выпущено'];
export const DRAFT_STATUSES = ['ждёт одобрения', 'одобрен', 'отклонён владельцем', 'опубликован'];
export const OWNER_ACTIONS = ['одобрил', 'поправил', 'отклонил'];
export const REJECTED_BY_CODE = 'отклонён кодом';
export const DEFAULT_DB = 'data/news.db';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  first_seen TEXT,
  independent_sources INTEGER NOT NULL DEFAULT 0,
  score INTEGER,
  reasons TEXT NOT NULL DEFAULT '[]',
  needs_owner INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'новое',
  status_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS event_sources (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  name TEXT,
  link TEXT NOT NULL,
  published TEXT,
  PRIMARY KEY (event_id, link)
);
CREATE INDEX IF NOT EXISTS idx_sources_link ON event_sources(link);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  link TEXT NOT NULL,
  published TEXT,
  first_seen TEXT NOT NULL,
  baseline INTEGER NOT NULL DEFAULT 0,
  image TEXT
);
CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id TEXT NOT NULL UNIQUE,
  event_id TEXT,
  file TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  url TEXT NOT NULL,
  source TEXT NOT NULL,
  license TEXT,
  author TEXT,
  width INTEGER,
  height INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_images_sha ON images(sha256);
CREATE INDEX IF NOT EXISTS idx_images_url ON images(url);
CREATE INDEX IF NOT EXISTS idx_items_seen ON items(first_seen);
CREATE TABLE IF NOT EXISTS polls (
  source TEXT NOT NULL,
  ts TEXT NOT NULL,
  ok INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_polls_ts ON polls(ts);
CREATE TABLE IF NOT EXISTS owner_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id TEXT NOT NULL,
  event_id TEXT,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_owner_actions_draft ON owner_actions(draft_id);
CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  style TEXT,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  gate_ok INTEGER NOT NULL DEFAULT 0,
  gate_reasons TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const minIso = (a, b) => (!a ? b : !b ? a : a <= b ? a : b);

/** Хранилище событий (node:sqlite). Источники и ссылки — только здесь, не в постах. */
export function openStore(path = DEFAULT_DB) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000'); // радар пишет в ту же базу
  db.exec(SCHEMA);
  if (!db.prepare('PRAGMA table_info(items)').all().some((c) => c.name === 'image')) db.exec('ALTER TABLE items ADD COLUMN image TEXT');

  const row = (r) => r && { ...r, reasons: JSON.parse(r.reasons), needs_owner: !!r.needs_owner };
  const withSources = (r) =>
    r && { ...row(r), sources: db.prepare('SELECT source, name, link, published FROM event_sources WHERE event_id = ? ORDER BY published, link').all(r.id) };

  return {
    /**
     * Записать событие. Если любая из ссылок уже есть в базе — это то же событие
     * (кластер мог получить новый id при росте): обновляем старую запись, статус не сбрасываем.
     * ev: { id, title, firstSeen, independentSources, score, reasons, needsOwner, sources:[{source,name,link,published}] }
     * Возвращает { id, created, status } — status до этой записи.
     */
    upsert(ev, now = new Date().toISOString()) {
      const links = ev.sources.map((s) => s.link);
      const found = links.length
        ? db.prepare(`SELECT DISTINCT e.id, e.created_at FROM events e JOIN event_sources s ON s.event_id = e.id WHERE s.link IN (${links.map(() => '?').join(',')}) ORDER BY e.created_at, e.id`).all(...links).map((r) => r.id)
        : [];
      if (!found.length && db.prepare('SELECT 1 FROM events WHERE id = ?').get(ev.id)) found.push(ev.id);
      const id = found[0] ?? ev.id;
      db.exec('BEGIN');
      try {
        const prev = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
        for (const other of found.slice(1)) { // несколько старых записей оказались одним событием
          db.prepare('INSERT OR IGNORE INTO event_sources SELECT ?, source, name, link, published FROM event_sources WHERE event_id = ?').run(id, other);
          db.prepare('DELETE FROM events WHERE id = ?').run(other);
        }
        const firstSeen = minIso(prev?.first_seen, ev.firstSeen ?? null);
        const vals = [ev.title, firstSeen, ev.independentSources, ev.score ?? null, JSON.stringify(ev.reasons ?? []), ev.needsOwner ? 1 : 0, now];
        if (prev) {
          db.prepare('UPDATE events SET title=?, first_seen=?, independent_sources=?, score=?, reasons=?, needs_owner=?, updated_at=? WHERE id=?').run(...vals, id);
        } else {
          db.prepare('INSERT INTO events (title, first_seen, independent_sources, score, reasons, needs_owner, updated_at, id, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(...vals, id, now);
        }
        const ins = db.prepare('INSERT OR IGNORE INTO event_sources (event_id, source, name, link, published) VALUES (?,?,?,?,?)');
        for (const s of ev.sources) ins.run(id, s.source, s.name ?? null, s.link, s.published ?? null);
        db.exec('COMMIT');
        return { id, created: !prev, status: prev?.status ?? 'новое' };
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    get: (id) => withSources(db.prepare('SELECT * FROM events WHERE id = ?').get(id)),
    list({ status } = {}) {
      const rows = status
        ? db.prepare('SELECT * FROM events WHERE status = ? ORDER BY score DESC, id').all(status)
        : db.prepare('SELECT * FROM events ORDER BY score DESC, id').all();
      return rows.map(withSources);
    },
    count: () => db.prepare('SELECT COUNT(*) AS n FROM events').get().n,
    setStatus(id, status, reason = null, now = new Date().toISOString()) {
      if (!STATUSES.includes(status)) throw new Error(`неизвестный статус: ${status}`);
      const r = db.prepare('UPDATE events SET status=?, status_reason=?, updated_at=? WHERE id=?').run(status, reason, now, id);
      if (!r.changes) throw new Error(`нет события ${id}`);
    },
    /** Радар: новые записи лент. first_seen ставится один раз (повтор id игнорируется). Возвращает число новых. */
    addItems(items, { now = new Date().toISOString(), baseline = false } = {}) {
      const ins = db.prepare('INSERT OR IGNORE INTO items (id, source, title, summary, link, published, first_seen, baseline, image) VALUES (?,?,?,?,?,?,?,?,?)');
      let added = 0;
      db.exec('BEGIN');
      try {
        for (const i of items) added += Number(ins.run(i.id, i.source, i.title, i.summary ?? null, i.link, i.published ?? null, now, baseline ? 1 : 0, i.image ?? null).changes);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return added;
    },
    hasItems: (source) => !!db.prepare('SELECT 1 FROM items WHERE source = ? LIMIT 1').get(source),
    itemsSince: (since) => db.prepare('SELECT * FROM items WHERE first_seen >= ? ORDER BY first_seen, id').all(since),
    recordPoll(source, { ok, count = 0, error = null }, ts = new Date().toISOString()) {
      db.prepare('INSERT INTO polls (source, ts, ok, count, error) VALUES (?,?,?,?,?)').run(source, ts, ok ? 1 : 0, count, error);
    },
    pollsSince: (since) => db.prepare('SELECT * FROM polls WHERE ts >= ? ORDER BY ts').all(since),
    /** summary события — из первой записи ленты по его ссылкам (наружу ссылки не отдаём). */
    summaryOf(eventId) {
      const r = db.prepare("SELECT i.summary FROM event_sources s JOIN items i ON i.link = s.link WHERE s.event_id = ? AND i.summary IS NOT NULL AND i.summary <> '' ORDER BY s.published, s.link LIMIT 1").get(eventId);
      return r?.summary ?? '';
    },
    /**
     * Черновик события. Один на событие: если уже есть и он не «отклонён кодом» — не трогаем
     * (возвращает { saved:false }); отклонённый кодом заменяется новой версией.
     * d: { eventId, style, text, gateOk, reasons }
     */
    addDraft(d, now = new Date().toISOString()) {
      const prev = db.prepare('SELECT * FROM drafts WHERE event_id = ?').get(d.eventId);
      if (prev && prev.status !== REJECTED_BY_CODE) return { saved: false, id: prev.id, status: prev.status };
      const status = d.gateOk ? 'ждёт одобрения' : REJECTED_BY_CODE;
      const id = prev?.id ?? `d-${d.eventId}`;
      const vals = [d.style ?? null, d.text, status, d.gateOk ? 1 : 0, JSON.stringify(d.reasons ?? []), now];
      if (prev) db.prepare('UPDATE drafts SET style=?, text=?, status=?, gate_ok=?, gate_reasons=?, updated_at=? WHERE id=?').run(...vals, id);
      else db.prepare('INSERT INTO drafts (style, text, status, gate_ok, gate_reasons, updated_at, id, event_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(...vals, id, d.eventId, now);
      return { saved: true, id, status };
    },
    /** Есть ли у события живой черновик (не «отклонён кодом»). */
    hasDraft: (eventId) => !!db.prepare('SELECT 1 FROM drafts WHERE event_id = ? AND status <> ?').get(eventId, REJECTED_BY_CODE),
    listDrafts({ status } = {}) {
      const sql = `SELECT d.*, e.score FROM drafts d LEFT JOIN events e ON e.id = d.event_id ${status ? 'WHERE d.status = ?' : ''} ORDER BY d.created_at, d.id`;
      const rows = status ? db.prepare(sql).all(status) : db.prepare(sql).all();
      return rows.map((r) => ({ ...r, gate_ok: !!r.gate_ok, gate_reasons: JSON.parse(r.gate_reasons) }));
    },
    setDraftStatus(id, status, now = new Date().toISOString()) {
      if (!DRAFT_STATUSES.includes(status)) throw new Error(`неизвестный статус черновика: ${status}`);
      const r = db.prepare('UPDATE drafts SET status=?, updated_at=? WHERE id=?').run(status, now, id);
      if (!r.changes) throw new Error(`нет черновика ${id}`);
    },
    getDraft(id) {
      const r = db.prepare('SELECT d.*, e.score FROM drafts d LEFT JOIN events e ON e.id = d.event_id WHERE d.id = ?').get(id);
      return r && { ...r, gate_ok: !!r.gate_ok, gate_reasons: JSON.parse(r.gate_reasons) };
    },
    /**
     * Действие владельца над черновиком «ждёт одобрения»: меняет черновик и пишет строку в журнал owner_actions
     * одной транзакцией. action: 'одобрил' | 'отклонил' (detail.reason необязательна) | 'поправил' (text + gateOk + reasons:
     * правка с непройденными воротами не принимается; в журнале остаются текст до и после).
     */
    ownerAct(id, action, { text, gateOk, reasons = [], reason = null } = {}, now = new Date().toISOString()) {
      if (!OWNER_ACTIONS.includes(action)) throw new Error(`неизвестное действие владельца: ${action}`);
      const d = db.prepare('SELECT * FROM drafts WHERE id = ?').get(id);
      if (!d) throw new Error(`нет черновика ${id}`);
      if (d.status !== 'ждёт одобрения') throw new Error(`черновик уже не ждёт одобрения (${d.status})`);
      let detail = {};
      db.exec('BEGIN');
      try {
        if (action === 'одобрил') {
          if (!d.gate_ok) throw new Error('черновик не прошёл ворота кодом');
          db.prepare('UPDATE drafts SET status=?, updated_at=? WHERE id=?').run('одобрен', now, id);
        } else if (action === 'отклонил') {
          detail = reason ? { reason: String(reason) } : {};
          db.prepare('UPDATE drafts SET status=?, updated_at=? WHERE id=?').run('отклонён владельцем', now, id);
        } else {
          const next = String(text ?? '').trim();
          if (!next) throw new Error('пустой текст');
          if (!gateOk) throw new Error('правка не прошла ворота кодом');
          detail = { before: d.text, after: next };
          db.prepare('UPDATE drafts SET text=?, gate_ok=1, gate_reasons=?, updated_at=? WHERE id=?').run(next, JSON.stringify(reasons), now, id);
        }
        db.prepare('INSERT INTO owner_actions (draft_id, event_id, action, detail, created_at) VALUES (?,?,?,?,?)').run(id, d.event_id, action, JSON.stringify(detail), now);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    ownerActions({ draftId, limit = 200 } = {}) {
      const rows = draftId
        ? db.prepare('SELECT * FROM owner_actions WHERE draft_id = ? ORDER BY id DESC LIMIT ?').all(draftId, limit)
        : db.prepare('SELECT * FROM owner_actions ORDER BY id DESC LIMIT ?').all(limit);
      return rows.map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
    },
    /** Ссылки и картинки лент события (для подбора картинки; наружу не отдаются). */
    eventMedia(eventId) {
      return db.prepare('SELECT s.link, i.image FROM event_sources s LEFT JOIN items i ON i.link = s.link WHERE s.event_id = ? ORDER BY s.published, s.link').all(eventId);
    },
    getImage: (draftId) => db.prepare('SELECT * FROM images WHERE draft_id = ?').get(draftId) ?? null,
    imageBySha: (sha) => db.prepare('SELECT * FROM images WHERE sha256 = ? LIMIT 1').get(sha) ?? null,
    imageByUrl: (url) => db.prepare('SELECT * FROM images WHERE url = ? LIMIT 1').get(url) ?? null,
    /** Одна картинка на черновик: повтор не плодит строк. */
    addImage(r, now = new Date().toISOString()) {
      db.prepare('INSERT OR IGNORE INTO images (draft_id, event_id, file, sha256, url, source, license, author, width, height, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(r.draftId, r.eventId ?? null, r.file, r.sha256, r.url, r.source, r.license ?? null, r.author ?? null, r.width ?? null, r.height ?? null, now);
    },
    close: () => db.close(),
  };
}
