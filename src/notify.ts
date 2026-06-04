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
  const messageLines = [sub.summary];
  if (sub.submitterNote) messageLines.push(`Note: ${sub.submitterNote}`);

  const payload: Record<string, unknown> = {
    title:    meta.title(label),
    message:  messageLines.join('\n'),
    priority: meta.priority,
    tags:     meta.tags,
  };
  if (adminUrl) payload.click = `${adminUrl}/api/admin/`;

  for (const rawUrl of webhookUrls) {
    const url = new URL(rawUrl);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    if (url.username) {
      headers['Authorization'] = `Basic ${btoa(`${url.username}:${url.password}`)}`;
      url.username = '';
      url.password = '';
    }

    fetch(url.toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    }).catch((err: Error) => {
      console.error(`[notify] webhook to ${url} failed: ${err.message}`);
    });
  }
}
