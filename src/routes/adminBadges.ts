import type { FastifyInstance } from 'fastify';
import { requireUserAdmin } from '../userAuth';
import {
  listBadges, getBadge, upsertBadge, deleteBadge,
  listUsers, getUser, getProfile, deleteUser, approveFlair, rejectFlair,
  grantBadge, revokeBadge, badgesForUser,
} from '../users';

// Admin-only management of the badge catalog and per-user grants. Gated by the
// SPA bearer-token admin check (requireUserAdmin) so the React admin page can
// call these with the signed-in user's id_token.
export async function registerAdminBadgeRoutes(app: FastifyInstance) {
  await app.register(async (admin) => {
    admin.addHook('preHandler', requireUserAdmin);

    // ── Badge catalog ──────────────────────────────────────────────────────
    admin.get('/api/admin/badges', async () => listBadges());

    // Create or update a badge (upsert keyed on its slug id).
    admin.post('/api/admin/badges', async (req, reply) => {
      const b = (req.body ?? {}) as {
        id?: string; name?: string; description?: string;
        icon?: string; color?: string; sort_order?: number;
      };
      const id = (b.id ?? '').trim();
      const name = (b.name ?? '').trim();
      if (!id || !name) return reply.code(400).send({ error: 'id and name are required' });
      if (!/^[a-z0-9-]+$/.test(id)) {
        return reply.code(400).send({ error: 'id must be a slug: lowercase letters, digits, and hyphens' });
      }
      upsertBadge({
        id, name,
        description: b.description, icon: b.icon, color: b.color, sort_order: b.sort_order,
      });
      return { ok: true, badge: getBadge(id) };
    });

    // Delete a badge (cascades to remove all its grants).
    admin.delete<{ Params: { id: string } }>('/api/admin/badges/:id', async (req, reply) => {
      const { id } = req.params;
      if (!getBadge(id)) return reply.code(404).send({ error: 'badge not found' });
      deleteBadge(id);
      return { ok: true };
    });

    // ── Users + grants ─────────────────────────────────────────────────────
    // Returns each known user together with their badges, so the admin UI can
    // render grant/revoke without an extra request per user.
    admin.get('/api/admin/users', async () =>
      listUsers().map(u => getProfile(u.sub)).filter(Boolean),
    );

    admin.get<{ Params: { sub: string } }>('/api/admin/users/:sub', async (req, reply) => {
      const profile = getProfile(req.params.sub);
      if (!profile) return reply.code(404).send({ error: 'user not found' });
      return profile;
    });

    // Remove a user from the worker DB (cascades to their badge grants). Use after
    // deleting them in Authentik — otherwise an active user is re-added on next sign-in.
    admin.delete<{ Params: { sub: string } }>('/api/admin/users/:sub', async (req, reply) => {
      const { sub } = req.params;
      if (!getUser(sub)) return reply.code(404).send({ error: 'user not found' });
      deleteUser(sub);
      return { ok: true };
    });

    // Approve a pending friend code → it becomes the user's live, displayed flair.
    admin.post<{ Params: { sub: string } }>('/api/admin/users/:sub/flair/approve', async (req, reply) => {
      const { sub } = req.params;
      if (!getUser(sub)) return reply.code(404).send({ error: 'user not found' });
      approveFlair(sub);
      return { ok: true, profile: getProfile(sub) };
    });

    // Reject a pending friend code → clears the request, live flair untouched.
    admin.post<{ Params: { sub: string } }>('/api/admin/users/:sub/flair/reject', async (req, reply) => {
      const { sub } = req.params;
      if (!getUser(sub)) return reply.code(404).send({ error: 'user not found' });
      rejectFlair(sub);
      return { ok: true, profile: getProfile(sub) };
    });

    // Grant a badge to a user. The user must have signed in at least once (so a
    // row exists), and the badge must exist — the FK would reject otherwise.
    admin.post<{ Params: { sub: string }; Body: { badgeId?: string } }>(
      '/api/admin/users/:sub/badges',
      async (req, reply) => {
        const { sub } = req.params;
        const badgeId = (req.body?.badgeId ?? '').trim();
        if (!badgeId) return reply.code(400).send({ error: 'badgeId is required' });
        if (!getUser(sub)) return reply.code(404).send({ error: 'user not found (they must sign in once first)' });
        if (!getBadge(badgeId)) return reply.code(404).send({ error: 'badge not found' });
        grantBadge(sub, badgeId, req.user?.username ?? null);
        return { ok: true, badges: badgesForUser(sub) };
      },
    );

    // Revoke a badge from a user (idempotent — fine if they didn't have it).
    admin.delete<{ Params: { sub: string; badgeId: string } }>(
      '/api/admin/users/:sub/badges/:badgeId',
      async (req) => {
        const { sub, badgeId } = req.params;
        revokeBadge(sub, badgeId);
        return { ok: true, badges: badgesForUser(sub) };
      },
    );
  });
}
