import { randomUUID } from 'node:crypto';
import { db } from './db';

// Site-wide announcement banners (maintenance notices, known-broken features,
// etc.), posted by admins and shown dismissibly on every page of the SPA.
// Shares the submissions SQLite connection.

export type AlertLevel = 'info' | 'warning' | 'critical';

export interface AlertRow {
  id: string;
  message: string;
  level: AlertLevel;
  active: 0 | 1;
  created_at: string;
  updated_at: string;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS alerts (
    id         TEXT PRIMARY KEY,
    message    TEXT NOT NULL,
    level      TEXT NOT NULL DEFAULT 'info',
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_alerts_active ON alerts(active, created_at);
`);

const stmts = {
  insert: db.prepare(`
    INSERT INTO alerts (id, message, level, active, created_at, updated_at)
    VALUES (@id, @message, @level, 1, @now, @now)
  `),
  update: db.prepare(`
    UPDATE alerts
       SET message    = @message,
           level      = @level,
           active     = @active,
           updated_at = @now
     WHERE id = @id
  `),
  setActive: db.prepare(`UPDATE alerts SET active = @active, updated_at = @now WHERE id = @id`),
  deleteById: db.prepare(`DELETE FROM alerts WHERE id = ?`),
  byId: db.prepare(`SELECT * FROM alerts WHERE id = ?`),
  listAll: db.prepare(`SELECT * FROM alerts ORDER BY created_at DESC`),
  listActive: db.prepare(`SELECT * FROM alerts WHERE active = 1 ORDER BY created_at DESC`),
};

export function getAlert(id: string): AlertRow | undefined {
  return stmts.byId.get(id) as AlertRow | undefined;
}

export function listAlerts(): AlertRow[] {
  return stmts.listAll.all() as AlertRow[];
}

export function listActiveAlerts(): AlertRow[] {
  return stmts.listActive.all() as AlertRow[];
}

export function createAlert(message: string, level: AlertLevel): AlertRow {
  const id = randomUUID();
  const now = new Date().toISOString();
  stmts.insert.run({ id, message, level, now });
  return getAlert(id)!;
}

export function updateAlert(
  id: string,
  patch: { message?: string; level?: AlertLevel; active?: boolean },
): AlertRow | undefined {
  const existing = getAlert(id);
  if (!existing) return undefined;
  stmts.update.run({
    id,
    message: patch.message ?? existing.message,
    level: patch.level ?? existing.level,
    active: (patch.active ?? !!existing.active) ? 1 : 0,
    now: new Date().toISOString(),
  });
  return getAlert(id);
}

export function setAlertActive(id: string, active: boolean): AlertRow | undefined {
  if (!getAlert(id)) return undefined;
  stmts.setActive.run({ id, active: active ? 1 : 0, now: new Date().toISOString() });
  return getAlert(id);
}

export function deleteAlert(id: string): void {
  stmts.deleteById.run(id);
}
