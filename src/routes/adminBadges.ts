import type { FastifyInstance } from 'fastify';
import type { AuthProvider } from '../auth';
import {
  listBadges, getBadge, upsertBadge, deleteBadge,
  listUsers, getUser, getProfile, grantBadge, revokeBadge, badgesForUser,
} from '../users';

// Admin-only management of the badge catalog and per-user grants. Registered in
// its own encapsulated scope so the requireAdmin gate applies to everything here,
// matching how the submission admin routes are structured.
export async function registerAdminBadgeRoutes(app: FastifyInstance, auth: AuthProvider) {
  await app.register(async (admin) => {
    admin.addHook('preHandler', auth.requireAdmin);

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
    admin.get('/api/admin/users', async () => listUsers());

    admin.get<{ Params: { sub: string } }>('/api/admin/users/:sub', async (req, reply) => {
      const profile = getProfile(req.params.sub);
      if (!profile) return reply.code(404).send({ error: 'user not found' });
      return profile;
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
        grantBadge(sub, badgeId, req.adminUser?.username ?? null);
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
