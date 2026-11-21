import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const STATUSES = ['новое', 'отобрано', 'отклонено', 'выпущено'];
export const DRAFT_STATUSES = ['ждёт одобрения', 'одобрен', 'отклонён владельцем', 'опубликован'];
export const OWNER_ACTIONS = ['одобрил', 'поправил', 'отклонил'];
// Owner marks in the personal feed (they do not change the draft status): the basis for learning taste.
export const OWNER_MARKS = ['важно', 'снял важно', 'не то'];
export const REJECTED_BY_CODE = 'отклонён кодом';
export const DEFAULT_DB = 'data/news.db';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  first_seen TEXT,
  independent_sources INTEGER NOT NULL DEFAULT 0,
  score INTEGER,
  peak_score INTEGER,
  section TEXT,
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
CREATE INDEX IF NOT EXISTS idx_es_event ON event_sources(event_id);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  link TEXT NOT NULL,
  published TEXT,
  first_seen TEXT NOT NULL,
  baseline INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  meta TEXT
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
CREATE INDEX IF NOT EXISTS idx_items_link ON items(link);
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
CREATE TABLE IF NOT EXISTS broadcasts (
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  day TEXT,
  draft_id TEXT,
  event_ids TEXT NOT NULL DEFAULT '[]',
  message_id TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (kind, key)
);
`;

const minIso = (a, b) => (!a ? b : !b ? a : a <= b ? a : b);

/** Event store (node:sqlite). Sources and links live only here, not in posts. */
export function openStore(path = DEFAULT_DB) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000'); // the radar writes to the same database
  // WAL: the panel reads the database while selection writes; without the journal the reader waited for the writer up to 30 s and the panel froze (29.10)
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  // migration of a live database: event category and "top of the day" (the owner's feed)
  const cols = db.prepare('PRAGMA table_info(events)').all().map((c) => c.name);
  if (!cols.includes('category')) db.exec('ALTER TABLE events ADD COLUMN category TEXT');
  if (!cols.includes('top_of_day')) db.exec('ALTER TABLE events ADD COLUMN top_of_day INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('breaking')) db.exec('ALTER TABLE events ADD COLUMN breaking INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('peak_score')) db.exec('ALTER TABLE events ADD COLUMN peak_score INTEGER');
  if (!cols.includes('hype')) db.exec('ALTER TABLE events ADD COLUMN hype INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('section')) db.exec('ALTER TABLE events ADD COLUMN section TEXT');
  const icols = db.prepare('PRAGMA table_info(items)').all().map((c) => c.name);
  if (!icols.includes('image')) db.exec('ALTER TABLE items ADD COLUMN image TEXT');
  if (!icols.includes('meta')) db.exec('ALTER TABLE items ADD COLUMN meta TEXT'); // hype signal numbers (points, comments, traffic) — JSON

  const dcols = db.prepare('PRAGMA table_info(drafts)').all().map((c) => c.name);
  if (!dcols.includes('message_id')) db.exec('ALTER TABLE drafts ADD COLUMN message_id TEXT');
  if (!dcols.includes('published_at')) db.exec('ALTER TABLE drafts ADD COLUMN published_at TEXT');

  const row = (r) => r && { ...r, reasons: JSON.parse(r.reasons), needs_owner: !!r.needs_owner };
  const withSources = (r) =>
    r && { ...row(r), sources: db.prepare('SELECT source, name, link, published FROM event_sources WHERE event_id = ? ORDER BY published, link').all(r.id) };

  return {
    /**
     * Write an event. If any of its links is already in the database, it is the same event
     * (the cluster may have got a new id as it grew): the old record is updated and the status is not reset.
     * ev: { id, title, firstSeen, independentSources, score, reasons, needsOwner, sources:[{source,name,link,published}] }
     * Returns { id, created, status } — status before this write.
     */
    upsert(ev, now = new Date().toISOString()) {
      const links = ev.sources.map((s) => s.link);
      const found = links.length
        ? db.prepare(`SELECT DISTINCT e.id, e.created_at FROM events e JOIN event_sources s ON s.event_id = e.id WHERE s.link IN (${links.map(() => '?').join(',')}) ORDER BY e.created_at, e.id`).all(...links).map((r) => r.id)
        : [];
      if (!found.length && db.prepare('SELECT 1 FROM events WHERE id = ?').get(ev.id)) found.push(ev.id);
      const id = found[0] ?? ev.id;
      db.exec('BEGIN IMMEDIATE');
      try {
        const prev = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
        for (const other of found.slice(1)) { // several old records turned out to be one event
          db.prepare('INSERT OR IGNORE INTO event_sources SELECT ?, source, name, link, published FROM event_sources WHERE event_id = ?').run(id, other);
          db.prepare('DELETE FROM events WHERE id = ?').run(other);
        }
        const firstSeen = minIso(prev?.first_seen, ev.firstSeen ?? null);
        const peak = Math.max(Number(prev?.peak_score ?? 0), Number(ev.score ?? 0));
        const hype = Math.max(Number(prev?.hype ?? 0), ev.hype ? 1 : 0); // признак хайпа не снимается
        const vals = [ev.title, firstSeen, ev.independentSources, ev.score ?? null, peak, JSON.stringify(ev.reasons ?? []), ev.needsOwner ? 1 : 0, hype, now];
        if (prev) {
          db.prepare('UPDATE events SET title=?, first_seen=?, independent_sources=?, score=?, peak_score=?, reasons=?, needs_owner=?, hype=?, updated_at=? WHERE id=?').run(...vals, id);
        } else {
          db.prepare('INSERT INTO events (title, first_seen, independent_sources, score, peak_score, reasons, needs_owner, hype, updated_at, id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(...vals, id, now);
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
      if (!STATUSES.includes(status)) throw new Error(`unknown status: ${status}`);
      const r = db.prepare('UPDATE events SET status=?, status_reason=?, updated_at=? WHERE id=?').run(status, reason, now, id);
      if (!r.changes) throw new Error(`no event ${id}`);
    },
    setCategory(id, category) {
      db.prepare('UPDATE events SET category=? WHERE id=?').run(category ?? null, id);
    },
    /** Diversity group (politics/war, world and emergencies, science, …). */
    setSection(id, section) {
      db.prepare('UPDATE events SET section=? WHERE id=?').run(section ?? null, id);
    },
    /** Urgent items of the day: breaking=1 for the listed ids, 0 for the rest of `scope`. */
    setBreakingFlags(breakingIds, scopeIds) {
      const up = db.prepare('UPDATE events SET breaking=? WHERE id=?');
      const on = new Set(breakingIds);
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const id of scopeIds) up.run(on.has(id) ? 1 : 0, id);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    /** The owner's feed: top_of_day=1 for the listed ids, 0 for the rest of `scope`. */
    setTopOfDay(topIds, scopeIds) {
      const up = db.prepare('UPDATE events SET top_of_day=? WHERE id=?');
      const top = new Set(topIds);
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const id of scopeIds) up.run(top.has(id) ? 1 : 0, id);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    /** Radar: new feed records. first_seen is set once (a repeated id is ignored). Returns the number of new ones. */
    addItems(items, { now = new Date().toISOString(), baseline = false } = {}) {
      const ins = db.prepare('INSERT OR IGNORE INTO items (id, source, title, summary, link, published, first_seen, baseline, image, meta) VALUES (?,?,?,?,?,?,?,?,?,?)');
      let added = 0;
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const i of items) added += Number(ins.run(i.id, i.source, i.title, i.summary ?? null, i.link, i.published ?? null, now, baseline ? 1 : 0, i.image ?? null, i.meta ? JSON.stringify(i.meta) : null).changes);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return added;
    },
    hasItems: (source) => !!db.prepare('SELECT 1 FROM items WHERE source = ? LIMIT 1').get(source),
    itemsSince: (since) => db.prepare('SELECT * FROM items WHERE first_seen >= ? ORDER BY first_seen, id').all(since),
    /** Time of the last poll of a source (for every_min of the hype sources). */
    lastPollTs: (source) => db.prepare('SELECT MAX(ts) AS ts FROM polls WHERE source = ?').get(source).ts ?? null,
    recordPoll(source, { ok, count = 0, error = null }, ts = new Date().toISOString()) {
      db.prepare('INSERT INTO polls (source, ts, ok, count, error) VALUES (?,?,?,?,?)').run(source, ts, ok ? 1 : 0, count, error);
    },
    pollsSince: (since) => db.prepare('SELECT * FROM polls WHERE ts >= ? ORDER BY ts').all(since),
    /** Event summary — from the first feed record matching its links (links are not exposed outside). */
    summaryOf(eventId) {
      const r = db.prepare("SELECT i.summary FROM event_sources s JOIN items i ON i.link = s.link WHERE s.event_id = ? AND i.summary IS NOT NULL AND i.summary <> '' ORDER BY s.published, s.link LIMIT 1").get(eventId);
      return r?.summary ?? '';
    },
    /**
     * Event draft. One per event: if one exists and it is not «отклонён кодом» (rejected by code), it is left alone
     * (returns { saved:false }); a draft rejected by code is replaced with a new version.
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
    /** Whether the event has a live draft (not «отклонён кодом», i.e. rejected by code). */
    hasDraft: (eventId) => !!db.prepare('SELECT 1 FROM drafts WHERE event_id = ? AND status <> ?').get(eventId, REJECTED_BY_CODE),
    listDrafts({ status } = {}) {
      const sql = `SELECT d.*, e.score FROM drafts d LEFT JOIN events e ON e.id = d.event_id ${status ? 'WHERE d.status = ?' : ''} ORDER BY d.created_at, d.id`;
      const rows = status ? db.prepare(sql).all(status) : db.prepare(sql).all();
      return rows.map((r) => ({ ...r, gate_ok: !!r.gate_ok, gate_reasons: JSON.parse(r.gate_reasons) }));
    },
    setDraftStatus(id, status, now = new Date().toISOString()) {
      if (!DRAFT_STATUSES.includes(status)) throw new Error(`unknown draft status: ${status}`);
      const r = db.prepare('UPDATE drafts SET status=?, updated_at=? WHERE id=?').run(status, now, id);
      if (!r.changes) throw new Error(`no draft ${id}`);
    },
    getDraft(id) {
      const r = db.prepare('SELECT d.*, e.score FROM drafts d LEFT JOIN events e ON e.id = d.event_id WHERE d.id = ?').get(id);
      return r && { ...r, gate_ok: !!r.gate_ok, gate_reasons: JSON.parse(r.gate_reasons) };
    },
    /**
     * Owner action on a draft «ждёт одобрения» (awaiting approval): changes the draft and writes a row to the owner_actions journal
     * in one transaction. action: 'одобрил' | 'отклонил' (detail.reason is optional) | 'поправил' (text + gateOk + reasons:
     * an edit that fails the gate is not accepted; the journal keeps the text before and after).
     */
    ownerAct(id, action, { text, gateOk, reasons = [], reason = null } = {}, now = new Date().toISOString()) {
      if (!OWNER_ACTIONS.includes(action)) throw new Error(`unknown owner action: ${action}`);
      const d = db.prepare('SELECT * FROM drafts WHERE id = ?').get(id);
      if (!d) throw new Error(`no draft ${id}`);
      if (d.status !== 'ждёт одобрения') throw new Error(`draft is no longer awaiting approval (${d.status})`);
      let detail = {};
      db.exec('BEGIN IMMEDIATE');
      try {
        if (action === 'одобрил') {
          if (!d.gate_ok) throw new Error('draft did not pass the code gate');
          db.prepare('UPDATE drafts SET status=?, updated_at=? WHERE id=?').run('одобрен', now, id);
        } else if (action === 'отклонил') {
          detail = reason ? { reason: String(reason) } : {};
          db.prepare('UPDATE drafts SET status=?, updated_at=? WHERE id=?').run('отклонён владельцем', now, id);
        } else {
          const next = String(text ?? '').trim();
          if (!next) throw new Error('empty text');
          if (!gateOk) throw new Error('edit did not pass the code gate');
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
    /**
     * Owner mark in the feed: 'важно' (like), 'снял важно' (unlike), 'не то' (hide; detail.reason — uninteresting | repeat | wrong).
     * The draft status is not changed — only a row is written to owner_actions, in any status.
     */
    ownerMark(id, action, { reason = null } = {}, now = new Date().toISOString()) {
      if (!OWNER_MARKS.includes(action)) throw new Error(`unknown mark: ${action}`);
      const d = db.prepare('SELECT event_id FROM drafts WHERE id = ?').get(id);
      if (!d) throw new Error(`no draft ${id}`);
      const detail = action === 'не то' && reason ? { reason: String(reason) } : {};
      db.prepare('INSERT INTO owner_actions (draft_id, event_id, action, detail, created_at) VALUES (?,?,?,?,?)').run(id, d.event_id, action, JSON.stringify(detail), now);
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
    /** Mark a publication: only from «одобрен» (approved), once. true — marked; false — already published or not approved. */
    markPublished(id, messageId, now = new Date().toISOString()) {
      return db.prepare('UPDATE drafts SET status=?, message_id=?, published_at=?, updated_at=? WHERE id=? AND status=?')
        .run('опубликован', String(messageId), now, now, id, 'одобрен').changes > 0;
    },
    /** Publication times not earlier than since (ISO), ascending. */
    // «Срочно» (urgent) goes outside the hourly queue and does not count toward its limit
    publishedTimes: (since = '') => db.prepare("SELECT published_at FROM drafts WHERE published_at IS NOT NULL AND published_at >= ? AND id NOT IN (SELECT draft_id FROM broadcasts WHERE kind = 'срочно' AND draft_id IS NOT NULL) ORDER BY published_at").all(since).map((r) => r.published_at),
    /**
     * Daily schedule: digests ('утро', 'вечер'; key = day in MSK) and «срочно» (urgent) (key = draft id).
     * A row reservation happens before sending: a repeated pass will not send the same thing twice. true — the reservation is ours.
     */
    /** Release the reservation if the message was not sent (so the next pass can try again). */
    releaseBroadcast: (kind, key) => db.prepare('DELETE FROM broadcasts WHERE kind = ? AND key = ?').run(kind, key).changes > 0,
    claimBroadcast(kind, key, { day = null, draftId = null, eventIds = [] } = {}, now = new Date().toISOString()) {
      return db.prepare('INSERT OR IGNORE INTO broadcasts (kind, key, day, draft_id, event_ids, created_at) VALUES (?,?,?,?,?,?)')
        .run(kind, key, day, draftId, JSON.stringify(eventIds), now).changes > 0;
    },
    finishBroadcast(kind, key, messageId, now = new Date().toISOString()) {
      db.prepare('UPDATE broadcasts SET message_id=?, published_at=? WHERE kind=? AND key=?').run(String(messageId), now, kind, key);
    },
    releaseBroadcast(kind, key) {
      db.prepare('DELETE FROM broadcasts WHERE kind=? AND key=? AND published_at IS NULL').run(kind, key);
    },
    hasBroadcast: (kind, key) => !!db.prepare('SELECT 1 FROM broadcasts WHERE kind=? AND key=?').get(kind, key),
    /** Published (with published_at) daily-schedule records, ascending by time. */
    broadcasts({ kind, since = '', day } = {}) {
      const rows = db.prepare('SELECT * FROM broadcasts WHERE published_at IS NOT NULL AND published_at >= ? ORDER BY published_at').all(since);
      return rows.filter((r) => (!kind || r.kind === kind) && (!day || r.day === day)).map((r) => ({ ...r, event_ids: JSON.parse(r.event_ids) }));
    },
    close: () => db.close(),
  };
}
