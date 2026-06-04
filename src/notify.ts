import { config } from './config';

export type NotifyEvent = 'submission.created' | 'submission.approved' | 'submission.rejected';

export interface SubmissionInfo {
  id: string;
  type: string;
  summary: string;
  submitterNote?: string | null;
  createdAt: string;
}

const META: Record<NotifyEvent, { title: (label: string) => string; tags: string[]; priority: number }> = {
  'submission.created':  { title: (l) => `New ${l} combination submitted for approval!`, tags: ['inbox_tray'],       priority: 3 },
  'submission.approved': { title: (l) => `${l} combination approved!`,                   tags: ['white_check_mark'], priority: 3 },
  'submission.rejected': { title: (l) => `${l} combination rejected!`,                   tags: ['x'],               priority: 3 },
};

// Extracts "Chroma" / "Glass" from summaries like "Chroma: Frog1 + Frog2 → Result".
function variantLabel(summary: string): string {
  const colon = summary.indexOf(':');
  return colon > 0 ? summary.slice(0, colon).trim() : summary;
}

export function notify(event: NotifyEvent, sub: SubmissionInfo): void {
  const { webhookUrls, adminUrl, on } = config.notify;

  const enabled =
    event === 'submission.created'  ? on.submit  :
    event === 'submission.approved' ? on.approve :
    on.reject;

  if (!enabled || webhookUrls.length === 0) return;

  const meta = META[event];
  const label = variantLabel(sub.summary);

  for (const rawUrl of webhookUrls) {
    const url = new URL(rawUrl);
    const headers: Record<string, string> = {
      'Content-Type': 'text/plain',
      'X-Title':      meta.title(label),
      'X-Priority':   String(meta.priority),
      'X-Tags':       meta.tags.join(','),
    };

    if (adminUrl) headers['X-Click'] = `${adminUrl}/api/admin/`;

    const { actionSecret } = config.notify;
    if (event === 'submission.created' && adminUrl && actionSecret) {
      const base = `${adminUrl}/api/action/${actionSecret}/${sub.id}`;
      headers['X-Actions'] = [
        `http, Approve, ${base}/approve, method=POST`,
        `http, Reject,  ${base}/reject,  method=POST`,
      ].join('; ');
    }
    if (url.username) {
      headers['Authorization'] = `Basic ${btoa(`${url.username}:${url.password}`)}`;
      url.username = '';
      url.password = '';
    }

    fetch(url.toString(), {
      method: 'POST',
      headers,
      body: sub.summary,
    }).catch((err: Error) => {
      console.error(`[notify] webhook to ${url} failed: ${err.message}`);
    });
  }
}
