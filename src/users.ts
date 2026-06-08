import { db } from './db';

// User profiles, the badge catalog, and badge grants. Everything is keyed on the
// Authentik subject ('sub') — the stable, opaque per-user id from the OIDC token,
// not a username (which can change). Shares the submissions SQLite connection.

export interface UserRow {
  sub: string;
  username: string | null; // cached preferred_username, for display/admin convenience
  flair: string | null;    // short freeform tagline shown next to the user
  created_at: string;      // ISO — first time we saw this user
  last_seen: string;       // ISO — refreshed on each profile fetch
}

export interface BadgeRow {
  id: string;               // slug, e.g. 'founder'
  name: string;
  description: string | null;
  icon: string | null;      // emoji or short icon token
  color: string | null;     // hex, e.g. '#6c5ce7'
  sort_order: number;
  created_at: string;
}

// What the SPA consumes: a user plus their earned badges.
export interface PublicProfile {
  sub: string;
  username: string | null;
  flair: string | null;
  badges: BadgeRow[];
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    sub        TEXT PRIMARY KEY,
    username   TEXT,
    flair      TEXT,
    created_at TEXT NOT NULL,
    last_seen  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS badges (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT,
    icon        TEXT,
    color       TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_badges (
    sub        TEXT NOT NULL,
    badge_id   TEXT NOT NULL,
    granted_at TEXT NOT NULL,
    granted_by TEXT,
    PRIMARY KEY (sub, badge_id),
    FOREIGN KEY (sub)      REFERENCES users(sub)  ON DELETE CASCADE,
    FOREIGN KEY (badge_id) REFERENCES badges(id)  ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_user_badges_sub ON user_badges(sub);
`);

const stmts = {
  upsertUser: db.prepare(`
    INSERT INTO users (sub, username, created_at, last_seen)
    VALUES (@sub, @username, @now, @now)
    ON CONFLICT(sub) DO UPDATE SET
      username  = excluded.username,
      last_seen = excluded.last_seen
  `),
  getUser:   db.prepare(`SELECT * FROM users WHERE sub = ?`),
  listUsers: db.prepare(`SELECT * FROM users ORDER BY last_seen DESC`),
  setFlair:  db.prepare(`UPDATE users SET flair = @flair WHERE sub = @sub`),

  listBadges: db.prepare(`SELECT * FROM badges ORDER BY sort_order, name`),
  getBadge:   db.prepare(`SELECT * FROM badges WHERE id = ?`),
  upsertBadge: db.prepare(`
    INSERT INTO badges (id, name, description, icon, color, sort_order, created_at)
    VALUES (@id, @name, @description, @icon, @color, @sort_order, @created_at)
    ON CONFLICT(id) DO UPDATE SET
      name        = excluded.name,
      description = excluded.description,
      icon        = excluded.icon,
      color       = excluded.color,
      sort_order  = excluded.sort_order
  `),
  deleteBadge: db.prepare(`DELETE FROM badges WHERE id = ?`),

  grantBadge: db.prepare(`
    INSERT INTO user_badges (sub, badge_id, granted_at, granted_by)
    VALUES (@sub, @badge_id, @granted_at, @granted_by)
    ON CONFLICT(sub, badge_id) DO NOTHING
  `),
  revokeBadge:   db.prepare(`DELETE FROM user_badges WHERE sub = @sub AND badge_id = @badge_id`),
  badgesForUser: db.prepare(`
    SELECT b.* FROM badges b
    JOIN user_badges ub ON ub.badge_id = b.id
    WHERE ub.sub = ?
    ORDER BY b.sort_order, b.name
  `),
};

// ── Users ────────────────────────────────────────────────────────────────────

// Records the user on first contact and refreshes username/last_seen thereafter.
// Call this whenever an authenticated request arrives so the directory stays current.
export function upsertUser(sub: string, username: string | null): void {
  stmts.upsertUser.run({ sub, username, now: new Date().toISOString() });
}

export function getUser(sub: string): UserRow | undefined {
  return stmts.getUser.get(sub) as UserRow | undefined;
}

// Everyone who has signed in at least once, most-recently-seen first. Used by
// the admin UI to pick who to award badges to.
export function listUsers(): UserRow[] {
  return stmts.listUsers.all() as UserRow[];
}

export function setFlair(sub: string, flair: string | null): void {
  stmts.setFlair.run({ sub, flair });
}

// User row + earned badges, in the shape the SPA renders. Null if unknown.
export function getProfile(sub: string): PublicProfile | null {
  const user = getUser(sub);
  if (!user) return null;
  return {
    sub: user.sub,
    username: user.username,
    flair: user.flair,
    badges: badgesForUser(sub),
  };
}

// ── Badge catalog ────────────────────────────────────────────────────────────

export function listBadges(): BadgeRow[] {
  return stmts.listBadges.all() as BadgeRow[];
}

export function getBadge(id: string): BadgeRow | undefined {
  return stmts.getBadge.get(id) as BadgeRow | undefined;
}

export function upsertBadge(
  badge: Pick<BadgeRow, 'id' | 'name'> & Partial<Omit<BadgeRow, 'id' | 'name' | 'created_at'>>,
): void {
  stmts.upsertBadge.run({
    id: badge.id,
    name: badge.name,
    description: badge.description ?? null,
    icon: badge.icon ?? null,
    color: badge.color ?? null,
    sort_order: badge.sort_order ?? 0,
    created_at: new Date().toISOString(),
  });
}

export function deleteBadge(id: string): void {
  stmts.deleteBadge.run(id);
}

// ── Badge grants ─────────────────────────────────────────────────────────────

// Grants a badge to a user. No-op if they already have it. `grantedBy` is the
// admin's identifier (username or sub) for an audit trail.
export function grantBadge(sub: string, badgeId: string, grantedBy: string | null): void {
  stmts.grantBadge.run({
    sub,
    badge_id: badgeId,
    granted_at: new Date().toISOString(),
    granted_by: grantedBy,
  });
}

export function revokeBadge(sub: string, badgeId: string): void {
  stmts.revokeBadge.run({ sub, badge_id: badgeId });
}

export function badgesForUser(sub: string): BadgeRow[] {
  return stmts.badgesForUser.all(sub) as BadgeRow[];
}
