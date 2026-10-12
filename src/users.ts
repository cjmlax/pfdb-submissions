import { many, one, run } from './db';

// User profiles, the badge catalog, and badge grants. Everything is keyed on the
// Zitadel user id ('sub') — the stable, opaque per-user id from the OIDC token,
// not a username (which can change). Tables are created in db.ts.

// Friend-code (flair) request state machine:
//   null      → no active request (flair may hold an approved code)
//   'pending' → user submitted a code, waiting for the admin to send the in-game
//               friend request and set a confirmation passphrase
//   'sent'    → admin sent it; user must enter the matching passphrase to publish
export type FlairStatus = 'pending' | 'sent' | null;

export interface UserRow {
  sub: string;
  username: string | null;        // cached preferred_username, for display/admin convenience
  flair: string | null;           // APPROVED in-game friend code, shown next to the user
  flair_pending: string | null;   // requested friend code while a request is active
  flair_status: FlairStatus;      // request state (see above); null when no active request
  flair_passphrase: string | null;// admin-set confirmation code (compared case-insensitively); never sent to the owner
  flair_sender_code: string | null; // the admin/mod's own Friend Code, set alongside flair_passphrase, so
                                     // the recipient can verify who the in-game gift is coming from
  flair_requested_at: string | null; // ISO time the user submitted the request
  connected_accounts: string | null; // JSON { platform: name }, from the user's Zitadel provider links
  display_source: string | null;  // which name they show site-wide: 'pfdb' (Friend Code) or a platform key
  show_credit: number;            // 1 = name them in public mutation credits (default), 0 = opted out
  created_at: string;             // ISO — first time we saw this user
  last_seen: string;              // ISO — refreshed on each profile fetch
}

export interface BadgeRow {
  id: string;               // slug, e.g. 'admin'
  name: string;
  description: string | null;
  icon: string | null;      // emoji or short icon token
  color: string | null;     // hex, e.g. '#6c5ce7'
  sort_order: number;
  created_at: string;
}

// What the SPA consumes: a user plus their earned badges. Note the passphrase is
// deliberately NOT included — the owner must learn it out-of-band to confirm.
export interface PublicProfile {
  sub: string;
  username: string | null;
  flair: string | null;         // approved friend code (displayed)
  flair_pending: string | null; // requested friend code while a request is active
  flair_status: FlairStatus;    // drives the Account page UI state
  flair_sender_code: string | null; // sender's Friend Code, shown while confirming a 'sent' gift
  display_source: string | null;    // chosen display-name source (see setDisplaySource)
  show_credit: boolean;             // named in public mutation credits
  connected_accounts: Record<string, string>; // linked platform → name on it (all, incl. sign-in-only)
  badges: BadgeRow[];
}

// Auto-managed badges, kept in sync with live PFDB role membership (see
// syncGroupBadge, called from userAuth.verify on every authenticated request).
// Their catalog entries can't be deleted from the admin UI (see AUTO_BADGE_IDS /
// routes/adminBadges.ts) since that would silently disable their sync until the
// worker restarts.
export const ADMIN_BADGE_ID = 'admin';
export const MOD_BADGE_ID = 'mod';
export const AUTO_BADGE_IDS: readonly string[] = [ADMIN_BADGE_ID, MOD_BADGE_ID];

// Seeded once via ON CONFLICT DO NOTHING so admins can freely re-style them
// afterward without a restart undoing it. Run at startup, after migrate().
export async function seedAutoBadges(): Promise<void> {
  for (const b of [
    { id: ADMIN_BADGE_ID, name: 'Admin', description: 'Holds the PFDB admin role.', icon: '🛡️', color: '#e74c3c', sort_order: -1000 },
    { id: MOD_BADGE_ID, name: 'Mod', description: 'Holds the PFDB mod role.', icon: '🛠️', color: '#2980b9', sort_order: -999 },
  ]) {
    await run(
      `INSERT INTO badges (id, name, description, icon, color, sort_order, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
      [b.id, b.name, b.description, b.icon, b.color, b.sort_order, new Date().toISOString()],
    );
  }
}

// ── Users ────────────────────────────────────────────────────────────────────

// Records the user on first contact and refreshes username/last_seen thereafter.
// Call this whenever an authenticated request arrives so the directory stays current.
// `connected` (their linked platforms, from Zitadel) is only refreshed when passed.
export async function upsertUser(sub: string, username: string | null, connected?: Record<string, string> | null): Promise<void> {
  const now = new Date().toISOString();
  await run(
    `INSERT INTO users (sub, username, connected_accounts, created_at, last_seen)
     VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT (sub) DO UPDATE SET
       username           = excluded.username,
       connected_accounts = COALESCE(excluded.connected_accounts, users.connected_accounts),
       last_seen          = excluded.last_seen`,
    [sub, username, connected ? JSON.stringify(connected) : null, now],
  );
}

// Replaces the stored linked platforms, e.g. after linking or unlinking one.
export async function setConnectedAccounts(sub: string, connected: Record<string, string>): Promise<void> {
  await run(`UPDATE users SET connected_accounts = $2 WHERE sub = $1`, [sub, JSON.stringify(connected)]);
}

// Connected platforms usable for sign-in only, never shown as a name — Google's
// account name is the user's email address. Keep in sync with the SPA's
// useDisplayName.
const SIGN_IN_ONLY_SOURCES = new Set(['google']);

function allConnectedAccounts(user: UserRow): Record<string, string> {
  try {
    return user.connected_accounts ? JSON.parse(user.connected_accounts) as Record<string, string> : {};
  } catch {
    return {};
  }
}

// The user's connected platforms that can be shown as a name.
function connectedAccounts(user: UserRow): Record<string, string> {
  return Object.fromEntries(
    Object.entries(allConnectedAccounts(user)).filter(([k]) => !SIGN_IN_ONLY_SOURCES.has(k)),
  );
}

// The user picks which name the site shows for them: 'pfdb' (their approved
// Friend Code) or one of their connected platforms. Only sources they actually
// have are accepted, so nobody can credit themselves under arbitrary text.
// Returns false (and changes nothing) for an unknown source.
export async function setDisplaySource(sub: string, source: string): Promise<boolean> {
  const user = await getUser(sub);
  if (!user) return false;
  if (source !== 'pfdb' && !(source in connectedAccounts(user))) return false;
  await run(`UPDATE users SET display_source = $2 WHERE sub = $1`, [sub, source]);
  return true;
}

// Whether the user is named in public mutation credits (opted in by default).
export async function setShowCredit(sub: string, show: boolean): Promise<void> {
  await run(`UPDATE users SET show_credit = $2 WHERE sub = $1`, [sub, show ? 1 : 0]);
}

// The name shown for a user publicly (e.g. mutation credits). Mirrors the SPA's
// useDisplayName: the chosen source if it still has a name, else the first
// available source (Friend Code, then platforms), else their username.
export function publicDisplayName(user: UserRow): string | null {
  const options: [string, string][] = [
    ['pfdb', user.flair ?? ''],
    ...Object.entries(connectedAccounts(user)).map(([k, v]): [string, string] => [k, String(v)]),
  ].filter(([, name]) => name) as [string, string][];
  const current = options.find(([k]) => k === user.display_source) ?? options[0];
  return current?.[1] || user.username;
}

export function getUser(sub: string): Promise<UserRow | undefined> {
  return one<UserRow>(`SELECT * FROM users WHERE sub = $1`, [sub]);
}

export function getUsers(subs: string[]): Promise<UserRow[]> {
  return many<UserRow>(`SELECT * FROM users WHERE sub = ANY($1)`, [subs]);
}

// Everyone who has signed in at least once, most-recently-seen first. Used by
// the admin UI to pick who to award badges to.
export function listUsers(): Promise<UserRow[]> {
  return many<UserRow>(`SELECT * FROM users ORDER BY last_seen DESC`);
}

// User submits a friend code → state becomes 'pending'. Live flair is untouched;
// any previously-set passphrase is cleared. Replaces an existing request.
export async function submitFlairRequest(sub: string, code: string): Promise<void> {
  await run(
    `UPDATE users
        SET flair_pending = $2, flair_status = 'pending',
            flair_passphrase = NULL, flair_sender_code = NULL, flair_requested_at = $3
      WHERE sub = $1`,
    [sub, code, new Date().toISOString()],
  );
}

// Clears any active request (user cancels, or admin denies). Live flair untouched.
export async function clearFlairRequest(sub: string): Promise<void> {
  await run(
    `UPDATE users
        SET flair_pending = NULL, flair_status = NULL,
            flair_passphrase = NULL, flair_sender_code = NULL, flair_requested_at = NULL
      WHERE sub = $1`,
    [sub],
  );
}

// Fully clears the Friend Code slot, including an already-approved live flair.
// Used when the owner clears their own published code from Account (as opposed
// to clearFlairRequest, which only cancels an in-flight request).
export async function clearFlair(sub: string): Promise<void> {
  await run(
    `UPDATE users
        SET flair = NULL, flair_pending = NULL, flair_status = NULL,
            flair_passphrase = NULL, flair_sender_code = NULL, flair_requested_at = NULL
      WHERE sub = $1`,
    [sub],
  );
}

// Admin marks the in-game friend request as Sent and records the confirmation
// passphrase the user must echo back, plus the sending admin/mod's own Friend
// Code (so the recipient can verify who the gift is from). Only valid from
// 'pending'; returns whether a row actually transitioned.
export async function markFlairSent(sub: string, passphrase: string, senderCode: string): Promise<boolean> {
  return (await run(
    `UPDATE users SET flair_status = 'sent', flair_passphrase = $2, flair_sender_code = $3
      WHERE sub = $1 AND flair_status = 'pending'`,
    [sub, passphrase, senderCode],
  )) > 0;
}

// User confirms with a passphrase. If the request is 'sent' and the value matches
// (case-insensitively), the friend code is published to their live flair and the
// request is cleared; returns true. Otherwise returns false and nothing changes.
export async function confirmFlairCode(sub: string, passphrase: string): Promise<boolean> {
  const user = await getUser(sub);
  if (!user || user.flair_status !== 'sent' || !user.flair_passphrase) return false;
  if (passphrase.trim().toLowerCase() !== user.flair_passphrase.trim().toLowerCase()) return false;
  await run(
    `UPDATE users
        SET flair = flair_pending, flair_pending = NULL, flair_status = NULL,
            flair_passphrase = NULL, flair_sender_code = NULL, flair_requested_at = NULL
      WHERE sub = $1`,
    [sub],
  );
  return true;
}

// Admin directly sets (or clears) a user's approved friend code, bypassing the
// submission workflow. Any active request is left untouched.
export async function setFlair(sub: string, flair: string | null): Promise<void> {
  await run(`UPDATE users SET flair = $2 WHERE sub = $1`, [sub, flair]);
}

// Every user with an active friend-code request, oldest first (queue order).
export function listFlairRequests(): Promise<UserRow[]> {
  return many<UserRow>(`SELECT * FROM users WHERE flair_status IS NOT NULL ORDER BY flair_requested_at ASC`);
}

// Removes a user and (via ON DELETE CASCADE) their badge grants. Note this only
// clears the worker's local row — if the same person signs in again while still
// active in Zitadel, upsertUser recreates the row on their next request.
export async function deleteUser(sub: string): Promise<void> {
  await run(`DELETE FROM users WHERE sub = $1`, [sub]);
}

// User row + earned badges, in the shape the SPA renders. Null if unknown.
export async function getProfile(sub: string): Promise<PublicProfile | null> {
  const user = await getUser(sub);
  if (!user) return null;
  return {
    sub: user.sub,
    username: user.username,
    flair: user.flair,
    flair_pending: user.flair_pending,
    flair_status: user.flair_status,
    flair_sender_code: user.flair_sender_code,
    display_source: user.display_source,
    show_credit: user.show_credit !== 0,
    connected_accounts: allConnectedAccounts(user),
    badges: await badgesForUser(sub),
  };
}

// ── Badge catalog ────────────────────────────────────────────────────────────

export function listBadges(): Promise<BadgeRow[]> {
  return many<BadgeRow>(`SELECT * FROM badges ORDER BY sort_order, name`);
}

export function getBadge(id: string): Promise<BadgeRow | undefined> {
  return one<BadgeRow>(`SELECT * FROM badges WHERE id = $1`, [id]);
}

export async function upsertBadge(
  badge: Pick<BadgeRow, 'id' | 'name'> & Partial<Omit<BadgeRow, 'id' | 'name' | 'created_at'>>,
): Promise<void> {
  await run(
    `INSERT INTO badges (id, name, description, icon, color, sort_order, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       name        = excluded.name,
       description = excluded.description,
       icon        = excluded.icon,
       color       = excluded.color,
       sort_order  = excluded.sort_order`,
    [
      badge.id, badge.name, badge.description ?? null, badge.icon ?? null, badge.color ?? null,
      badge.sort_order ?? 0, new Date().toISOString(),
    ],
  );
}

export async function deleteBadge(id: string): Promise<void> {
  await run(`DELETE FROM badges WHERE id = $1`, [id]);
}

// ── Badge grants ─────────────────────────────────────────────────────────────

// Grants a badge to a user. No-op if they already have it. `grantedBy` is the
// admin's identifier (username or sub) for an audit trail.
export async function grantBadge(sub: string, badgeId: string, grantedBy: string | null): Promise<void> {
  await run(
    `INSERT INTO user_badges (sub, badge_id, granted_at, granted_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (sub, badge_id) DO NOTHING`,
    [sub, badgeId, new Date().toISOString(), grantedBy],
  );
}

export async function revokeBadge(sub: string, badgeId: string): Promise<void> {
  await run(`DELETE FROM user_badges WHERE sub = $1 AND badge_id = $2`, [sub, badgeId]);
}

export function badgesForUser(sub: string): Promise<BadgeRow[]> {
  return many<BadgeRow>(
    `SELECT b.* FROM badges b
       JOIN user_badges ub ON ub.badge_id = b.id
      WHERE ub.sub = $1
      ORDER BY b.sort_order, b.name`,
    [sub],
  );
}

// Grants/revokes one of the auto-managed badges (see AUTO_BADGE_IDS above) to
// match live PFDB role membership, called on every verified request (see
// userAuth.verify) for each auto-managed role. This is what makes the badges
// self-healing — no manual grant/revoke ever needed. No-ops if the user hasn't
// been recorded yet (their next /api/me call upserts them and syncs on the
// following request) or if the badge catalog entry was deleted (avoids a
// grantBadge FK failure).
export async function syncGroupBadge(sub: string, badgeId: string, inGroup: boolean): Promise<void> {
  if (!(await getUser(sub)) || !(await getBadge(badgeId))) return;
  const has = (await badgesForUser(sub)).some(b => b.id === badgeId);
  if (inGroup && !has) await grantBadge(sub, badgeId, 'system');
  else if (!inGroup && has) await revokeBadge(sub, badgeId);
}

// ── Weekly Set completions ──────────────────────────────────────────────────
// Per-user, per-set "completed" flag (checkbox column on the Weekly Sets
// table). weeklySetId is the Teable record id of the set — no server-side
// validation that it's a real row, since a bogus id is scoped to the owner's
// own list and harmless.

export async function markWeeklyCompleted(sub: string, weeklySetId: string): Promise<void> {
  await run(
    `INSERT INTO user_weekly_completions (sub, weekly_set_id, completed_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (sub, weekly_set_id) DO NOTHING`,
    [sub, weeklySetId, new Date().toISOString()],
  );
}

export async function clearWeeklyCompleted(sub: string, weeklySetId: string): Promise<void> {
  await run(`DELETE FROM user_weekly_completions WHERE sub = $1 AND weekly_set_id = $2`, [sub, weeklySetId]);
}

export async function completedWeeklySetIds(sub: string): Promise<string[]> {
  const rows = await many<{ weekly_set_id: string }>(
    `SELECT weekly_set_id FROM user_weekly_completions WHERE sub = $1`, [sub],
  );
  return rows.map(r => r.weekly_set_id);
}
