import type { ServerResponse } from 'node:http';

const clients = new Set<ServerResponse>();

export function addSseClient(res: ServerResponse): void {
  clients.add(res);
}

export function removeSseClient(res: ServerResponse): void {
  clients.delete(res);
}

export function broadcastSse(event: string, data: unknown): void {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(msg);
    } catch {
      clients.delete(res);
    }
  }
}
