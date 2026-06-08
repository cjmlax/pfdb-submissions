import type { FastifyRequest, preHandlerHookHandler } from 'fastify';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { config } from './config';

// Identifies a regular (non-admin) signed-in user from the public SPA. The SPA
// sends its OIDC **id_token** as a Bearer token; we verify the signature against
// Authentik's JWKS and pull the identity out. The id_token (not the access token)
// is used because it already carries our custom claims — pfdb_groups and the
// connected accounts — so no extra userinfo round-trip is needed. This mirrors
// how the admin OIDC flow verifies tokens, but points at the separate public app.

declare module 'fastify' {
  interface FastifyRequest {
    user?: { sub: string; username: string | null; groups: string[] };
  }
}

let cachedIssuer: string | null = null;
let jwks: JWTVerifyGetKey | null = null;

async function getKeys(): Promise<{ issuer: string; jwks: JWTVerifyGetKey }> {
  if (cachedIssuer && jwks) return { issuer: cachedIssuer, jwks };
  const base = config.userAuth.issuer.replace(/\/$/, '');
  const res = await fetch(`${base}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`User OIDC discovery failed (${res.status}) at ${base}`);
  const meta = (await res.json()) as { issuer: string; jwks_uri: string };
  jwks = createRemoteJWKSet(new URL(meta.jwks_uri));
  cachedIssuer = meta.issuer;
  return { issuer: cachedIssuer, jwks };
}

function bearerToken(req: FastifyRequest): string | null {
  const header = String(req.headers.authorization ?? '');
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : null;
}

// Verifies the bearer token and returns the identity, or null if absent/invalid.
async function verify(req: FastifyRequest): Promise<FastifyRequest['user'] | null> {
  const token = bearerToken(req);
  if (!token) return null;
  try {
    const { issuer, jwks: keys } = await getKeys();
    const { payload } = await jwtVerify(token, keys, {
      issuer,
      audience: config.userAuth.clientId,
    });
    const sub = typeof payload.sub === 'string' ? payload.sub : null;
    if (!sub) return null;

    const groupsClaim = payload[config.userAuth.groupsClaim];
    const groups = Array.isArray(groupsClaim) ? groupsClaim.map(String) : [];
    const username =
      typeof payload.preferred_username === 'string' ? payload.preferred_username
      : typeof payload.name === 'string' ? payload.name
      : null;

    return { sub, username, groups };
  } catch {
    return null;
  }
}

// Rejects the request with 401 unless it carries a valid SPA token.
export const requireUser: preHandlerHookHandler = async (req, reply) => {
  const user = await verify(req);
  if (!user) return reply.code(401).send({ error: 'unauthorized' });
  req.user = user;
};

// Attaches req.user when a valid token is present, but allows anonymous access.
// Use for endpoints that render differently for signed-in vs anonymous callers.
export const optionalUser: preHandlerHookHandler = async (req) => {
  const user = await verify(req);
  if (user) req.user = user;
};

// Like requireUser, but also requires the SPA admin group. Lets the React admin
// UI manage badges with the signed-in user's bearer token (no admin cookie).
export const requireUserAdmin: preHandlerHookHandler = async (req, reply) => {
  const user = await verify(req);
  if (!user) return reply.code(401).send({ error: 'unauthorized' });
  if (!user.groups.includes(config.userAuth.adminGroup)) {
    return reply.code(403).send({ error: 'forbidden' });
  }
  req.user = user;
};

// True if the signed-in user is in the given PFDB group (e.g. 'admin', 'mod').
export function userInGroup(req: FastifyRequest, group: string): boolean {
  return req.user?.groups.includes(group) ?? false;
}
