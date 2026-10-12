import type { FastifyRequest, preHandlerHookHandler } from 'fastify';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { config } from './config';
import { syncGroupBadge, ADMIN_BADGE_ID, MOD_BADGE_ID } from './users';

// Identifies a signed-in user from the public SPA. The SPA sends its OIDC
// **id_token** as a Bearer token; we verify the signature against Zitadel's JWKS
// and pull the identity out. The id_token (not the access token) is used because
// the pfdb-web app puts the user's project roles in it, so no extra userinfo
// round-trip is needed. Linked provider accounts aren't in the token; see
// zitadel.connectedAccounts.

declare module 'fastify' {
  interface FastifyRequest {
    user?: {
      sub: string;
      username: string | null;
      roles: string[];
    };
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

    // Zitadel's roles claim is an object keyed by role name:
    // { "admins": { "<org id>": "<org domain>" }, ... }.
    const rolesClaim = payload[config.userAuth.rolesClaim];
    const roles = rolesClaim && typeof rolesClaim === 'object' && !Array.isArray(rolesClaim)
      ? Object.keys(rolesClaim)
      : [];

    // Users created from a provider sign-in often get their email as the login
    // name; never use that as a (possibly public) username.
    const preferred = typeof payload.preferred_username === 'string' ? payload.preferred_username : null;
    const username =
      preferred && !preferred.includes('@') ? preferred
      : typeof payload.name === 'string' ? payload.name
      : null;

    // Self-healing: sync the auto-managed Admin/Mod badges to this request's
    // live roles, so they're granted/revoked without any manual action.
    await syncGroupBadge(sub, ADMIN_BADGE_ID, roles.includes(config.userAuth.adminRole));
    await syncGroupBadge(sub, MOD_BADGE_ID, roles.includes(config.userAuth.modRole));

    return { sub, username, roles };
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

// Like requireUser, but also requires the SPA admin role. Lets the React admin
// UI manage badges with the signed-in user's bearer token (no admin cookie).
export const requireUserAdmin: preHandlerHookHandler = async (req, reply) => {
  const user = await verify(req);
  if (!user) return reply.code(401).send({ error: 'unauthorized' });
  if (!user.roles.includes(config.userAuth.adminRole)) {
    return reply.code(403).send({ error: 'forbidden' });
  }
  req.user = user;
};

// Like requireUser, but also requires the SPA mod role. Deliberately separate
// from admin: a user can hold either role without the other, and admin alone
// doesn't grant mod tools.
export const requireUserMod: preHandlerHookHandler = async (req, reply) => {
  const user = await verify(req);
  if (!user) return reply.code(401).send({ error: 'unauthorized' });
  if (!user.roles.includes(config.userAuth.modRole)) {
    return reply.code(403).send({ error: 'forbidden' });
  }
  req.user = user;
};

// True if the signed-in user holds the given PFDB role (e.g. 'admins', 'mods').
export function userHasRole(req: FastifyRequest, role: string): boolean {
  return req.user?.roles.includes(role) ?? false;
}
