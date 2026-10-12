import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../config';

// Zitadel Actions v2 target for the response of
// /zitadel.user.v2.UserService/RetrieveIdentityProviderIntent.
//
// Twitch and Discord are Generic OAuth providers in Zitadel (Zitadel has no
// template for either, and Twitch's OIDC userinfo call fails, see the HAProxy
// Twitch shim). Zitadel's Generic OAuth provider maps nothing from the
// provider's profile except the user id. Login v2 then has
// no email, username or name for the account, so it can't auto-link by email and
// falls back to its "Complete your data" form. Zitadel leaves that mapping to
// Actions: it sends us the intent response (with the provider's raw userinfo),
// and whatever we return replaces it. We fill the empty fields for those
// providers and return every other response unchanged.
//
// Zitadel replaces the whole response with our reply, so this must always echo
// the response back, even when it changes nothing.

const PATH = '/api/zitadel/actions/idp-intent';
const SIGNATURE_TOLERANCE_SECONDS = 300;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// ZITADEL-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">
function validSignature(body: string, header: string | undefined, key: string): boolean {
  if (!header || !key) return false;
  let t: number | undefined;
  const sigs: Buffer[] = [];
  for (const part of header.split(',')) {
    const [name, value] = part.split('=');
    if (name === 't') t = Number(value);
    else if (name === 'v1' && value && /^[0-9a-f]+$/i.test(value)) sigs.push(Buffer.from(value, 'hex'));
  }
  if (!t || !Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = createHmac('sha256', key).update(`${t}.${body}`).digest();
  return sigs.some((s) => s.length === expected.length && timingSafeEqual(s, expected));
}

interface ProviderProfile { username?: string; email?: string; emailVerified: boolean }

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

// How to read each Generic OAuth provider's userinfo, keyed by the platform key
// used in ZITADEL_IDP_* (see config.zitadel.idps).
const PROFILE_READERS: Record<string, (info: Json) => ProviderProfile> = {
  // https://id.twitch.tv/oauth2/userinfo (fields requested through ?claims= on the authorize URL)
  twitch: (info) => ({
    username: str(info.preferred_username),
    email: str(info.email),
    emailVerified: info.email_verified === true,
  }),
  // https://discord.com/api/users/@me (scopes: identify email)
  discord: (info) => ({
    username: str(info.global_name) ?? str(info.username),
    email: str(info.email),
    emailVerified: info.verified === true,
  }),
};

// The provider's userinfo, as Zitadel stored it. The Generic OAuth user is
// serialized as {"RawInfo": {...}}; accept the bare object too in case that changes.
function rawUserinfo(resp: Json): Json {
  const raw = resp.idpInformation?.rawInformation ?? {};
  return (raw.RawInfo ?? raw) as Json;
}

// Fills the empty profile fields of a new-user request (the deprecated
// addHumanUser and the newer createUser.human share these shapes).
function fillHuman(target: Json | undefined, username?: string, email?: string, emailVerified?: boolean) {
  if (!target) return;
  if (username) {
    target.profile = target.profile ?? {};
    if (!target.profile.givenName) target.profile.givenName = username;
    if (!target.profile.familyName) target.profile.familyName = username;
    if (!target.profile.displayName) target.profile.displayName = username;
    for (const link of (target.idpLinks ?? []) as Json[]) {
      if (!link.userName) link.userName = username;
    }
  }
  if (email) {
    target.email = target.email ?? {};
    if (!target.email.email) target.email.email = email;
    if (emailVerified) {
      delete target.email.sendCode; // verification is a oneof: sendCode | returnCode | isVerified
      delete target.email.returnCode;
      target.email.isVerified = true;
    }
  }
}

// Returns the platform key it mapped, or undefined if it left the response alone.
export function mapIntent(resp: Json, idps: Record<string, string>): string | undefined {
  const key = idps[resp.idpInformation?.idpId ?? ''];
  const read = key ? PROFILE_READERS[key] : undefined;
  if (!read) return undefined; // Google and other providers Zitadel maps itself
  const { username, email, emailVerified } = read(rawUserinfo(resp));
  if (!username && !email) return undefined;

  if (username && !resp.idpInformation.userName) resp.idpInformation.userName = username;

  // Zitadel login name: the email, as for Google sign-ins, so it can't collide
  // with another user's provider name. The provider name becomes the display name.
  const loginName = email ?? username;

  const add = resp.addHumanUser as Json | undefined;
  if (add) {
    if (loginName && !add.username) add.username = loginName;
    fillHuman(add, username, email, emailVerified);
  }
  const create = resp.createUser as Json | undefined;
  if (create) {
    if (loginName && !create.username) create.username = loginName;
    fillHuman(create.human, username, email, emailVerified);
  }
  return key;
}

export async function registerZitadelActionRoutes(app: FastifyInstance) {
  await app.register(async (scope) => {
    // The signature covers the exact bytes Zitadel sent, so keep the body as a string.
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));

    scope.post(PATH, { config: { rateLimit: { max: 1000, timeWindow: '1 minute' } } }, async (req, reply) => {
      const body = typeof req.body === 'string' ? req.body : '';
      if (!config.zitadel.actionSigningKey) {
        return reply.code(503).send({ error: 'not configured' });
      }
      const header = req.headers['zitadel-signature'];
      if (!validSignature(body, Array.isArray(header) ? header[0] : header, config.zitadel.actionSigningKey)) {
        req.log.warn('zitadel action: bad or missing signature');
        return reply.code(401).send({ error: 'bad signature' });
      }

      let payload: Json;
      try {
        payload = JSON.parse(body) as Json;
      } catch {
        return reply.code(400).send({ error: 'bad json' });
      }
      const resp = payload.response as Json | undefined;
      if (!resp || typeof resp !== 'object') return reply.code(400).send({ error: 'no response in payload' });

      const mapped = mapIntent(resp, config.zitadel.idps);
      if (mapped) req.log.info({ provider: mapped }, 'zitadel action: mapped provider profile');
      return reply.type('application/json').send(JSON.stringify(resp));
    });
  });
}
