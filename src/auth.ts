import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { config } from './config';

// Identity attached to a request once authorized.
declare module 'fastify' {
  interface FastifyRequest {
    adminUser?: { username: string; groups: string[] };
  }
}

export interface AuthProvider {
  // preHandler that 403s/redirects unless the caller is an admin.
  requireAdmin: preHandlerHookHandler;
  // Optional routes (login/callback/logout) for modes that need them.
  register?: (app: FastifyInstance) => void | Promise<void>;
  // Where the admin page should point its "log in" / "log out" links, if any.
  loginPath: string | null;
  logoutPath: string | null;
}

const SESSION_COOKIE = 'pfdb_admin';
const STATE_COOKIE = 'pfdb_oidc_state';

function wantsHtml(req: FastifyRequest): boolean {
  return String(req.headers.accept ?? '').includes('text/html');
}

function denied(req: FastifyRequest, reply: FastifyReply, loginPath: string | null) {
  if (loginPath && wantsHtml(req)) return reply.redirect(loginPath);
  return reply.code(401).send({ error: 'unauthorized' });
}

// ── forward: trust headers injected by Authentik via Nginx Proxy Manager ──────
function forwardProvider(): AuthProvider {
  const { adminGroup, userHeader, groupsHeader, proxySecret } = config.auth;
  return {
    loginPath: null,
    logoutPath: null,
    requireAdmin: async (req, reply) => {
      // If configured, only trust identity headers when the request also carries
      // the shared secret NPM injects — defeats header spoofing if the worker
      // port is ever reachable directly.
      if (proxySecret && req.headers['x-proxy-secret'] !== proxySecret) {
        return reply.code(403).send({ error: 'forbidden', detail: 'missing/invalid proxy secret' });
      }
      const username = String(req.headers[userHeader] ?? '').trim();
      const groups = String(req.headers[groupsHeader] ?? '')
        .split(/[,|]/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (!username || !groups.includes(adminGroup)) {
        return reply.code(403).send({ error: 'forbidden', detail: `requires group "${adminGroup}"` });
      }
      req.adminUser = { username, groups };
    },
  };
}

// ── password: self-contained login (emergency fallback) ───────────────────────
function passwordProvider(): AuthProvider {
  function setSession(reply: FastifyReply, username: string) {
    reply.setCookie(SESSION_COOKIE, username, {
      signed: true, httpOnly: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 8,
    });
  }
  return {
    loginPath: '/api/auth/login',
    logoutPath: '/api/auth/logout',
    register: (app) => {
      app.get('/api/auth/login', async (_req, reply) => {
        reply.type('text/html').send(loginPage());
      });
      app.post('/api/auth/login', async (req, reply) => {
        if (!config.auth.password) return reply.code(500).send('ADMIN_PASSWORD is not set');
        const password = (req.body as { password?: string } | undefined)?.password ?? '';
        if (password !== config.auth.password) {
          return reply.code(401).type('text/html').send(loginPage('Incorrect password.'));
        }
        setSession(reply, 'admin');
        return reply.redirect('/api/admin/');
      });
      app.post('/api/auth/logout', async (_req, reply) => {
        reply.clearCookie(SESSION_COOKIE, { path: '/' });
        return reply.redirect('/api/auth/login');
      });
    },
    requireAdmin: async (req, reply) => {
      const raw = req.cookies[SESSION_COOKIE];
      if (!raw) return denied(req, reply, '/api/auth/login');
      const un = req.unsignCookie(raw);
      if (!un.valid || !un.value) return denied(req, reply, '/api/auth/login');
      req.adminUser = { username: un.value, groups: [config.auth.adminGroup] };
    },
  };
}

// ── oidc: the worker runs the Authentik code flow itself ──────────────────────
function oidcProvider(): AuthProvider {
  const o = config.auth.oidc;
  let discovery: { authorization_endpoint: string; token_endpoint: string; issuer: string } | null = null;
  let jwks: JWTVerifyGetKey | null = null;

  async function discover() {
    if (discovery && jwks) return discovery;
    const url = `${o.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OIDC discovery failed (${res.status}) at ${url}`);
    const meta = (await res.json()) as typeof discovery & { jwks_uri: string };
    jwks = createRemoteJWKSet(new URL(meta!.jwks_uri));
    discovery = meta;
    return discovery;
  }

  return {
    loginPath: '/api/auth/login',
    logoutPath: '/api/auth/logout',
    register: (app) => {
      app.get('/api/auth/login', async (_req, reply) => {
        const meta = await discover();
        const state = randomBytes(16).toString('hex');
        reply.setCookie(STATE_COOKIE, state, {
          signed: true, httpOnly: true, sameSite: 'lax', path: '/', maxAge: 600,
        });
        const url = new URL(meta!.authorization_endpoint);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('client_id', o.clientId);
        url.searchParams.set('redirect_uri', o.redirectUri);
        url.searchParams.set('scope', o.scope);
        url.searchParams.set('state', state);
        return reply.redirect(url.toString());
      });

      app.get('/api/auth/callback', async (req, reply) => {
        const q = req.query as { code?: string; state?: string };
        const stateRaw = req.cookies[STATE_COOKIE];
        const state = stateRaw ? req.unsignCookie(stateRaw) : { valid: false, value: null };
        if (!state.valid || !q.state || state.value !== q.state) {
          return reply.code(400).send('Invalid OAuth state');
        }
        reply.clearCookie(STATE_COOKIE, { path: '/' });
        if (!q.code) return reply.code(400).send('Missing authorization code');

        const meta = await discover();
        const tokenRes = await fetch(meta!.token_endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: q.code,
            redirect_uri: o.redirectUri,
            client_id: o.clientId,
            client_secret: o.clientSecret,
          }),
        });
        if (!tokenRes.ok) {
          const t = await tokenRes.text().catch(() => '');
          return reply.code(401).send(`Token exchange failed: ${t.slice(0, 300)}`);
        }
        const tokens = (await tokenRes.json()) as { id_token?: string };
        if (!tokens.id_token) return reply.code(401).send('No id_token returned');

        const { payload } = await jwtVerify(tokens.id_token, jwks!, {
          issuer: meta!.issuer,
          audience: o.clientId,
        });
        const claim = payload[o.groupsClaim];
        const groups = Array.isArray(claim) ? claim.map(String) : [];
        if (!groups.includes(config.auth.adminGroup)) {
          return reply.code(403).type('text/html').send(
            `<p>Forbidden — your account is not in the "${config.auth.adminGroup}" group.</p>`,
          );
        }
        const username = String(payload.preferred_username ?? payload.email ?? payload.sub ?? 'admin');
        const session = Buffer.from(JSON.stringify({ u: username, g: groups })).toString('base64url');
        reply.setCookie(SESSION_COOKIE, session, {
          signed: true, httpOnly: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 8,
        });
        return reply.redirect('/api/admin/');
      });

      app.post('/api/auth/logout', async (_req, reply) => {
        reply.clearCookie(SESSION_COOKIE, { path: '/' });
        return reply.redirect('/api/auth/login');
      });
    },
    requireAdmin: async (req, reply) => {
      const raw = req.cookies[SESSION_COOKIE];
      if (!raw) return denied(req, reply, '/api/auth/login');
      const un = req.unsignCookie(raw);
      if (!un.valid || !un.value) return denied(req, reply, '/api/auth/login');
      try {
        const data = JSON.parse(Buffer.from(un.value, 'base64url').toString()) as { u: string; g: string[] };
        if (!Array.isArray(data.g) || !data.g.includes(config.auth.adminGroup)) {
          return reply.code(403).send({ error: 'forbidden' });
        }
        req.adminUser = { username: data.u, groups: data.g };
      } catch {
        return denied(req, reply, '/api/auth/login');
      }
    },
  };
}

export function getAuthProvider(): AuthProvider {
  switch (config.auth.mode) {
    case 'forward':
      return forwardProvider();
    case 'password':
      return passwordProvider();
    case 'oidc':
      return oidcProvider();
    default:
      throw new Error(`Unknown AUTH_MODE: ${config.auth.mode}`);
  }
}

// Minimal password-mode login page.
function loginPage(error?: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pfdb submissions — admin login</title>
<style>
  body{font-family:system-ui,sans-serif;background:#1a1a1a;color:#eee;display:grid;place-items:center;height:100vh;margin:0}
  form{background:#242424;padding:28px;border-radius:10px;border:1px solid #333;min-width:280px}
  h1{font-size:18px;margin:0 0 16px}
  input{width:100%;box-sizing:border-box;padding:9px;border-radius:6px;border:1px solid #444;background:#1a1a1a;color:#eee}
  button{margin-top:12px;width:100%;padding:9px;border:0;border-radius:6px;background:#4a7;color:#062;font-weight:600;cursor:pointer}
  .err{color:#e66;font-size:14px;margin:0 0 12px}
</style></head><body>
<form method="post" action="/api/auth/login">
  <h1>Admin login</h1>
  ${error ? `<p class="err">${error}</p>` : ''}
  <input type="password" name="password" placeholder="Password" autofocus required>
  <button type="submit">Sign in</button>
</form></body></html>`;
}
