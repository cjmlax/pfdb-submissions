import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { config } from './config';
import { getAuthProvider } from './auth';
import { registerPublicRoutes } from './routes/public';
import { registerAdminRoutes } from './routes/admin';
import { registerActionRoutes } from './routes/actions';

async function main() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: true, // we sit behind Nginx Proxy Manager
  });

  await app.register(cookie, { secret: config.auth.cookieSecret });
  await app.register(formbody); // parses the password-login form post
  await app.register(multipart, { limits: { fileSize: config.upload.maxBytes, files: 1 } });
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  await app.register(cors, {
    origin: config.allowedOrigin.includes('*') ? true : config.allowedOrigin,
    methods: ['GET', 'POST'],
  });

  app.get('/healthz', async () => ({ ok: true, mode: config.auth.mode }));

  const auth = getAuthProvider();
  if (auth.register) await auth.register(app);

  await registerPublicRoutes(app);
  await registerAdminRoutes(app, auth);
  await registerActionRoutes(app);

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    `pfdb-submissions up — auth=${config.auth.mode}, data=${config.dataDir}, origins=${config.allowedOrigin.join(',')}`,
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
