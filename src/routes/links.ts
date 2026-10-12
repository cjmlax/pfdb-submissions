import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../config';
import { one, run } from '../db';
import { requireUser } from '../userAuth';
import { getProfile, setConnectedAccounts } from '../users';
import {
  ZitadelError, addIdpLink, connectedAccounts, listIdpLinks, removeIdpLink, retrieveIdpIntent, startIdpIntent,
  zitadelConfigured,
} from '../zitadel';

// Linking another provider (Discord, Twitch, Google) to a signed-in user's
// account. Zitadel has no self-service page for this, so the worker runs
// Zitadel's intent flow itself:
//
//   1. POST /api/me/links/:provider — start an intent, remember it against the
//      verified user, set a short-lived cookie tied to it, return the provider URL.
//   2. The browser signs in at the provider; Zitadel sends it back to
//      GET /api/me/links/callback?id=<intent>&token=<token>.
//   3. The callback checks the cookie matches the intent (so nobody can trick a
//      user into attaching an attacker's provider account to theirs), reads the
//      provider account from the intent, links it, and returns to /account.

const COOKIE = 'pfdb_link';
const CALLBACK_PATH = '/api/me/links/callback';
const INTENT_TTL_SECONDS = 600;

const sha256 = (s: string) => createHash('sha256').update(s).digest();

// Platform key → Zitadel identity provider id.
function idpIdFor(provider: string): string | undefined {
  return Object.entries(config.zitadel.idps).find(([, key]) => key === provider)?.[0];
}

// Where the callback lands the browser: the Account page, with an outcome the
// SPA turns into a message.
function accountUrl(outcome: string, provider?: string): string {
  const q = new URLSearchParams({ link: outcome, ...(provider ? { provider } : {}) });
  return `/account?${q}`;
}

// Re-reads the user's links from Zitadel into the stored profile.
async function refreshConnected(sub: string): Promise<void> {
  const connected = await connectedAccounts(sub);
  if (connected) await setConnectedAccounts(sub, connected);
}

export async function registerLinkRoutes(app: FastifyInstance) {
  app.post<{ Params: { provider: string } }>(
    '/api/me/links/:provider',
    { preHandler: requireUser, config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (req, reply) => {
      if (!zitadelConfigured()) return reply.code(503).send({ error: 'Account linking is not available.' });
      const idpId = idpIdFor(req.params.provider);
      if (!idpId) return reply.code(404).send({ error: 'Unknown provider.' });

      const { sub } = req.user!;
      const links = await listIdpLinks(sub);
      if (links.some(l => l.idpId === idpId)) {
        return reply.code(409).send({ error: 'That provider is already linked to your account.' });
      }

      const callback = `${config.siteUrl}${CALLBACK_PATH}`;
      const intent = await startIdpIntent(idpId, callback, callback);

      const nonce = randomBytes(32).toString('base64url');
      await run(`DELETE FROM link_intents WHERE expires_at < now()`);
      await run(
        `INSERT INTO link_intents (id, sub, idp_id, nonce_hash, expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))`,
        [intent.id, sub, idpId, sha256(nonce).toString('hex'), INTENT_TTL_SECONDS],
      );
      reply.setCookie(COOKIE, nonce, {
        path: CALLBACK_PATH,
        httpOnly: true,
        secure: config.siteUrl.startsWith('https:'),
        sameSite: 'lax', // sent on the top-level redirect back from Zitadel
        maxAge: INTENT_TTL_SECONDS,
      });
      return { authUrl: intent.authUrl };
    },
  );

  app.get<{ Querystring: { id?: string; token?: string } }>(CALLBACK_PATH, async (req, reply) => {
    const nonce = req.cookies[COOKIE];
    reply.clearCookie(COOKIE, { path: CALLBACK_PATH });

    const intentId = req.query.id ?? '';
    const intent = intentId
      ? await one<{ sub: string; idp_id: string; nonce_hash: string }>(
        `DELETE FROM link_intents WHERE id = $1 AND expires_at > now() RETURNING sub, idp_id, nonce_hash`,
        [intentId],
      )
      : undefined;
    const provider = intent ? config.zitadel.idps[intent.idp_id] : undefined;

    const expected = intent ? Buffer.from(intent.nonce_hash, 'hex') : null;
    const got = nonce ? sha256(nonce) : null;
    if (!intent || !expected || !got || expected.length !== got.length || !timingSafeEqual(expected, got)) {
      req.log.warn({ intentId }, 'account link callback did not match a pending link');
      return reply.redirect(accountUrl('expired', provider));
    }

    // No token means the provider sign-in failed or was cancelled.
    if (!req.query.token) return reply.redirect(accountUrl('cancelled', provider));

    try {
      const link = await retrieveIdpIntent(intentId, req.query.token);
      if (link.idpId !== intent.idp_id) throw new Error('intent provider mismatch');
      await addIdpLink(intent.sub, link);
    } catch (e) {
      // Each provider account can belong to only one Zitadel user; if it already
      // signed in on its own, it's a separate PFDB account.
      if (e instanceof ZitadelError && e.status === 409) {
        return reply.redirect(accountUrl('taken', provider));
      }
      req.log.error({ err: e, sub: intent.sub }, 'account link failed');
      return reply.redirect(accountUrl('error', provider));
    }

    await refreshConnected(intent.sub);
    req.log.info({ sub: intent.sub, provider }, 'provider account linked');
    return reply.redirect(accountUrl('linked', provider));
  });

  app.delete<{ Params: { provider: string } }>(
    '/api/me/links/:provider',
    { preHandler: requireUser },
    async (req, reply) => {
      if (!zitadelConfigured()) return reply.code(503).send({ error: 'Account linking is not available.' });
      const idpId = idpIdFor(req.params.provider);
      if (!idpId) return reply.code(404).send({ error: 'Unknown provider.' });

      const { sub } = req.user!;
      const links = await listIdpLinks(sub);
      const link = links.find(l => l.idpId === idpId);
      if (!link) return reply.code(404).send({ error: 'That provider is not linked to your account.' });
      // Users sign in only through providers, so the last link is the only way in.
      if (links.length <= 1) {
        return reply.code(409).send({ error: 'This is your only way to sign in, so it can’t be removed.' });
      }

      await removeIdpLink(sub, link);
      await refreshConnected(sub);
      return getProfile(sub);
    },
  );
}
