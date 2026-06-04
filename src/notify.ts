import { config } from './config';

export type NotifyEvent = 'submission.created' | 'submission.approved' | 'submission.rejected';

export interface SubmissionInfo {
  id: string;
  type: string;
  summary: string;
  submitterNote?: string | null;
  createdAt: string;
}

const META: Record<NotifyEvent, { verb: string; tags: string[]; priority: number }> = {
  'submission.created':  { verb: 'New',     tags: ['inbox_tray'],       priority: 3 },
  'submission.approved': { verb: 'Approved', tags: ['white_check_mark'], priority: 3 },
  'submission.rejected': { verb: 'Rejected', tags: ['x'],               priority: 3 },
};

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function notify(event: NotifyEvent, sub: SubmissionInfo): void {
  const { webhookUrls, adminUrl, on } = config.notify;

  const enabled =
    event === 'submission.created'  ? on.submit  :
    event === 'submission.approved' ? on.approve :
    on.reject;

  if (!enabled || webhookUrls.length === 0) return;

  const meta = META[event];
  const messageLines = [sub.summary];
  if (sub.submitterNote) messageLines.push(`Note: ${sub.submitterNote}`);

  const payload: Record<string, unknown> = {
    // ntfy-compatible fields
    title:    `${meta.verb} ${cap(sub.type)} Submission`,
    message:  messageLines.join('\n'),
    priority: meta.priority,
    tags:     meta.tags,
    // structured data for generic webhook consumers
    event,
    submission: sub,
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
