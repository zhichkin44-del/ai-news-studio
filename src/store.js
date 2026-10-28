import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const STATUSES = ['новое', 'отобрано', 'отклонено', 'выпущено'];
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
`;

const minIso = (a, b) => (!a ? b : !b ? a : a <= b ? a : b);

/** Хранилище событий (node:sqlite). Источники и ссылки — только здесь, не в постах. */
export function openStore(path = DEFAULT_DB) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

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
    close: () => db.close(),
  };
}
