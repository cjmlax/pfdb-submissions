import { randomUUID } from 'node:crypto';
import { many, one, run } from './db';

// Site-wide announcement banners (maintenance notices, known-broken features,
// etc.), posted by admins and shown dismissibly on every page of the SPA.
// The table is created in db.ts.

export type AlertLevel = 'info' | 'warning' | 'critical';

export interface AlertRow {
  id: string;
  message: string;
  level: AlertLevel;
  active: 0 | 1;
  created_at: string;
  updated_at: string;
}

export function getAlert(id: string): Promise<AlertRow | undefined> {
  return one<AlertRow>(`SELECT * FROM alerts WHERE id = $1`, [id]);
}

export function listAlerts(): Promise<AlertRow[]> {
  return many<AlertRow>(`SELECT * FROM alerts ORDER BY created_at DESC`);
}

export function listActiveAlerts(): Promise<AlertRow[]> {
  return many<AlertRow>(`SELECT * FROM alerts WHERE active = 1 ORDER BY created_at DESC`);
}

export async function createAlert(message: string, level: AlertLevel): Promise<AlertRow> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await run(
    `INSERT INTO alerts (id, message, level, active, created_at, updated_at) VALUES ($1, $2, $3, 1, $4, $4)`,
    [id, message, level, now],
  );
  return (await getAlert(id))!;
}

export async function updateAlert(
  id: string,
  patch: { message?: string; level?: AlertLevel; active?: boolean },
): Promise<AlertRow | undefined> {
  const existing = await getAlert(id);
  if (!existing) return undefined;
  await run(
    `UPDATE alerts SET message = $2, level = $3, active = $4, updated_at = $5 WHERE id = $1`,
    [
      id,
      patch.message ?? existing.message,
      patch.level ?? existing.level,
      (patch.active ?? !!existing.active) ? 1 : 0,
      new Date().toISOString(),
    ],
  );
  return getAlert(id);
}

export async function setAlertActive(id: string, active: boolean): Promise<AlertRow | undefined> {
  if (!(await getAlert(id))) return undefined;
  await run(`UPDATE alerts SET active = $2, updated_at = $3 WHERE id = $1`, [id, active ? 1 : 0, new Date().toISOString()]);
  return getAlert(id);
}

export async function deleteAlert(id: string): Promise<void> {
  await run(`DELETE FROM alerts WHERE id = $1`, [id]);
}
