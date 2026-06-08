import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { config } from './config';
import { registerPublicRoutes } from './routes/public';
import { registerAdminRoutes } from './routes/admin';
import { registerAdminBadgeRoutes } from './routes/adminBadges';
import { registerItunesPoller } from './tasks/itunesPoller';
import { registerWeeklySetsPoller } from './tasks/weeklySetsPoller';

async function main() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: true, // we sit behind Nginx Proxy Manager
  });

  await app.register(multipart, { limits: { fileSize: config.upload.maxBytes, files: 1 } });
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  await app.register(cors, {
    origin: config.allowedOrigin.includes('*') ? true : config.allowedOrigin,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  });

  app.get('/healthz', async () => ({ ok: true }));

  await registerPublicRoutes(app);
  await registerAdminRoutes(app);
  await registerAdminBadgeRoutes(app);

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    `pfdb-submissions up — data=${config.dataDir}, origins=${config.allowedOrigin.join(',')}`,
  );
  registerItunesPoller(app.log);
  registerWeeklySetsPoller(app.log);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
