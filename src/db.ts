import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { config } from './config';

export type Status = 'pending' | 'rejected' | 'pushed' | 'error';

export interface SubmissionRow {
  id: string;
  type: string;
  payload: string; // JSON
  status: Status;
  summary: string;
  screenshot: string | null; // stored filename in uploads/
  submitter_note: string | null;
  reviewer_note: string | null;
  source_ip: string | null; // hashed
  created_at: string; // ISO
  reviewed_at: string | null;
  pushed_ref: string | null; // Teable record id after a successful push
}

export const uploadsDir = path.join(config.dataDir, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

export const db = new Database(path.join(config.dataDir, 'submissions.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON'); // enforce FK constraints (used by the users/badges tables)

db.exec(`
  CREATE TABLE IF NOT EXISTS submissions (
    id             TEXT PRIMARY KEY,
    type           TEXT NOT NULL,
    payload        TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending',
    summary        TEXT NOT NULL,
    screenshot     TEXT,
    submitter_note TEXT,
    reviewer_note  TEXT,
    source_ip      TEXT,
    created_at     TEXT NOT NULL,
    reviewed_at    TEXT,
    pushed_ref     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status, created_at);
`);

export const queries = {
  insert: db.prepare(`
    INSERT INTO submissions
      (id, type, payload, status, summary, screenshot, submitter_note, source_ip, created_at)
    VALUES
      (@id, @type, @payload, 'pending', @summary, @screenshot, @submitter_note, @source_ip, @created_at)
  `),
  byId: db.prepare(`SELECT * FROM submissions WHERE id = ?`),
  listByStatus: db.prepare(`SELECT * FROM submissions WHERE status = ? ORDER BY created_at DESC`),
  setStatus: db.prepare(`
    UPDATE submissions
       SET status = @status,
           reviewer_note = @reviewer_note,
           reviewed_at = @reviewed_at,
           pushed_ref = @pushed_ref
     WHERE id = @id
  `),
  update: db.prepare(`
    UPDATE submissions
       SET payload    = @payload,
           summary    = @summary,
           screenshot = @screenshot
     WHERE id = @id
       AND status = 'pending'
  `),
};

export function getById(id: string): SubmissionRow | undefined {
  return queries.byId.get(id) as SubmissionRow | undefined;
}

export function listByStatus(status: Status): SubmissionRow[] {
  return queries.listByStatus.all(status) as SubmissionRow[];
}
