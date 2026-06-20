import type { FastifyInstance } from 'fastify';
import { requireUserAdmin } from '../userAuth';
import {
  listAlerts, createAlert, updateAlert, deleteAlert, getAlert, type AlertLevel, type AlertRow,
} from '../alerts';

const LEVELS = new Set<AlertLevel>(['info', 'warning', 'critical']);

function toDto(a: AlertRow) {
  return {
    id: a.id,
    message: a.message,
    level: a.level,
    active: !!a.active,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
  };
}

// Admin-only management of site-wide announcement banners. Gated by the SPA
// bearer-token admin check so the React admin page can call these with the
// signed-in user's id_token.
export async function registerAdminAlertRoutes(app: FastifyInstance) {
  await app.register(async (admin) => {
    admin.addHook('preHandler', requireUserAdmin);

    admin.get('/api/admin/alerts', async () => listAlerts().map(toDto));

    admin.post<{ Body: { message?: string; level?: string } }>(
      '/api/admin/alerts',
      async (req, reply) => {
        const message = (req.body?.message ?? '').trim();
        const level = (req.body?.level ?? 'info') as AlertLevel;
        if (!message) return reply.code(400).send({ error: 'message is required' });
        if (!LEVELS.has(level)) return reply.code(400).send({ error: 'level must be info, warning, or critical' });
        return { ok: true, alert: toDto(createAlert(message, level)) };
      },
    );

    admin.patch<{ Params: { id: string }; Body: { message?: string; level?: string; active?: boolean } }>(
      '/api/admin/alerts/:id',
      async (req, reply) => {
        const { id } = req.params;
        if (!getAlert(id)) return reply.code(404).send({ error: 'alert not found' });
        const { message, level, active } = req.body ?? {};
        if (level !== undefined && !LEVELS.has(level as AlertLevel)) {
          return reply.code(400).send({ error: 'level must be info, warning, or critical' });
        }
        if (message !== undefined && !message.trim()) {
          return reply.code(400).send({ error: 'message cannot be empty' });
        }
        const updated = updateAlert(id, {
          message: message?.trim(),
          level: level as AlertLevel | undefined,
          active,
        });
        return { ok: true, alert: toDto(updated!) };
      },
    );

    admin.delete<{ Params: { id: string } }>('/api/admin/alerts/:id', async (req, reply) => {
      const { id } = req.params;
      if (!getAlert(id)) return reply.code(404).send({ error: 'alert not found' });
      deleteAlert(id);
      return { ok: true };
    });
  });
}
