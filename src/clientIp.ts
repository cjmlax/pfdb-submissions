import type { FastifyRequest } from 'fastify';

// The visitor's address. Every request arrives through cloudflared and HAProxy,
// so the socket address is always a proxy. Cloudflare sets CF-Connecting-IP to
// the real client, and cloudflared is the only way in, so it can be trusted.
// X-Forwarded-For (leftmost entry) covers anything that skips Cloudflare, such as
// local dev.
export function clientIp(req: FastifyRequest): string {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();
  const xff = req.headers['x-forwarded-for'];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
  return first || req.socket.remoteAddress || 'unknown';
}
