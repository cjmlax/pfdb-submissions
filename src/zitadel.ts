import http from 'node:http';
import https from 'node:https';
import { config } from './config';

// Zitadel's v2 API, called as the pfdb-worker machine user. Zitadel picks the
// instance from the Host header, and fetch() won't let us override Host, so
// this goes through node:http directly.

export class ZitadelError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`Zitadel API ${status}: ${body.slice(0, 300)}`);
  }
}

export function zitadelConfigured(): boolean {
  return !!config.zitadel.serviceToken && Object.keys(config.zitadel.idps).length > 0;
}

function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = new URL(config.zitadel.apiUrl + path);
  const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method,
      headers: {
        Host: config.zitadel.publicHost,
        Authorization: `Bearer ${config.zitadel.serviceToken}`,
        Accept: 'application/json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
      },
      timeout: 10_000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) return reject(new ZitadelError(status, text));
        try {
          resolve((text ? JSON.parse(text) : {}) as T);
        } catch {
          reject(new ZitadelError(status, `unparseable response: ${text}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Zitadel API timed out')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

export interface IdpLink {
  idpId: string;
  userId: string;   // the user's id at the provider
  userName: string; // the user's name at the provider
}

// Every provider account linked to a Zitadel user.
export async function listIdpLinks(zitadelUserId: string): Promise<IdpLink[]> {
  const res = await call<{ result?: IdpLink[] }>(
    'POST', `/v2/users/${encodeURIComponent(zitadelUserId)}/links/_search`, {},
  );
  return res.result ?? [];
}

// The user's linked platforms as { platform key: name on it }, for the
// providers configured in ZITADEL_IDP_*. Null if Zitadel isn't configured or
// can't be reached, so callers keep whatever they stored last.
export async function connectedAccounts(zitadelUserId: string): Promise<Record<string, string> | null> {
  if (!zitadelConfigured()) return null;
  try {
    const links = await listIdpLinks(zitadelUserId);
    const out: Record<string, string> = {};
    for (const link of links) {
      const key = config.zitadel.idps[link.idpId];
      if (key && link.userName) out[key] = link.userName;
    }
    return out;
  } catch {
    return null;
  }
}

// Starts a provider sign-in whose result comes back to successUrl/failureUrl
// with ?id=<intent id>&token=<intent token>. Returns the provider URL to send
// the browser to.
export async function startIdpIntent(
  idpId: string, successUrl: string, failureUrl: string,
): Promise<{ id: string; authUrl: string }> {
  const res = await call<{ authUrl?: string; idpIntent?: { idpIntentId?: string } }>(
    'POST', '/v2/idp_intents', { idpId, urls: { successUrl, failureUrl } },
  );
  if (!res.authUrl) throw new Error('Zitadel did not return a provider URL for this sign-in.');
  // Redirect-based providers don't echo the intent id in the response; Zitadel
  // uses it as the OAuth state, which is how the callback is matched to it.
  const id = res.idpIntent?.idpIntentId || new URL(res.authUrl).searchParams.get('state') || '';
  if (!id) throw new Error('Could not identify this provider sign-in.');
  return { id, authUrl: res.authUrl };
}

// The provider account a finished intent signed in to.
export async function retrieveIdpIntent(intentId: string, token: string): Promise<IdpLink> {
  const res = await call<{ idpInformation?: { idpId?: string; userId?: string; userName?: string } }>(
    'POST', `/v2/idp_intents/${encodeURIComponent(intentId)}`, { idpIntentToken: token },
  );
  const info = res.idpInformation;
  if (!info?.idpId || !info.userId) throw new Error('Zitadel returned no provider account for this sign-in.');
  return { idpId: info.idpId, userId: info.userId, userName: info.userName ?? '' };
}

export async function addIdpLink(zitadelUserId: string, link: IdpLink): Promise<void> {
  await call('POST', `/v2/users/${encodeURIComponent(zitadelUserId)}/links`, { idpLink: link });
}

export async function removeIdpLink(zitadelUserId: string, link: IdpLink): Promise<void> {
  await call(
    'DELETE',
    `/v2/users/${encodeURIComponent(zitadelUserId)}/links/${encodeURIComponent(link.idpId)}/${encodeURIComponent(link.userId)}`,
  );
}
