import { config } from './config';
import { getHandler } from './handlers/registry';

export type NotifyEvent =
  | 'submission.created'
  | 'submission.approved'
  | 'submission.rejected'
  | 'flair.requested';

export interface SubmissionInfo {
  id: string;
  type: string;
  summary: string;
  submitterNote?: string | null;
  createdAt: string;
}

const META: Record<NotifyEvent, { title: (label: string) => string; tags: string[]; priority: number }> = {
  'submission.created':  { title: (l) => `New ${l} submitted for approval!`,        tags: ['inbox_tray'],       priority: 3 },
  'submission.approved': { title: (l) => `${l} approved!`,                          tags: ['white_check_mark'], priority: 3 },
  'submission.rejected': { title: (l) => `${l} rejected!`,                          tags: ['x'],               priority: 3 },
  'flair.requested':     { title: ()  => `New friend code submitted for approval!`, tags: ['handshake'],        priority: 3 },
};

// Names the kind of submission for the title. Combos read "Chroma combination" /
// "Glass combination", pulled from summaries like "Chroma: Frog1 + Frog2 → Result";
// other types use their handler's label.
function kindLabel(sub: SubmissionInfo): string {
  if (sub.type === 'combo') {
    const colon = sub.summary.indexOf(':');
    return `${colon > 0 ? sub.summary.slice(0, colon).trim() : 'Special'} combination`;
  }
  return getHandler(sub.type)?.label ?? sub.type;
}

interface Message {
  title: string;
  body: string;
  tags: string[];
  priority: number;
  click?: string;
}

function send(msg: Message): void {
  for (const rawUrl of config.notify.webhookUrls) {
    const url = new URL(rawUrl);
    const headers: Record<string, string> = {
      'Content-Type': 'text/plain',
      'X-Title':      msg.title,
      'X-Priority':   String(msg.priority),
      'X-Tags':       msg.tags.join(','),
    };

    if (msg.click) headers['X-Click'] = msg.click;

    if (url.username && url.password) {
      headers['Authorization'] = `Basic ${btoa(`${url.username}:${url.password}`)}`;
      url.username = '';
      url.password = '';
    } else if (url.username) {
      // Token auth: https://<token>@ntfy.example.com/topic
      headers['Authorization'] = `Bearer ${url.username}`;
      url.username = '';
    }

    fetch(url.toString(), {
      method: 'POST',
      headers,
      body: msg.body,
    }).catch((err: Error) => {
      console.error(`[notify] webhook to ${url} failed: ${err.message}`);
    });
  }
}

// Background pollers (version history, weekly sets) report failures here so
// they're visible without watching the container logs.
export function notifyPollerFailure(poller: string, details: string[]): void {
  const { webhookUrls, on } = config.notify;
  if (!on.pollerFailure || webhookUrls.length === 0 || details.length === 0) return;
  send({
    title:    `${poller} poller failed`,
    body:     details.join('\n'),
    tags:     ['warning'],
    priority: 4,
  });
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function notify(event: NotifyEvent, sub: SubmissionInfo): void {
  const { webhookUrls, adminUrl, on } = config.notify;

  const enabled =
    event === 'submission.created'  ? on.submit  :
    event === 'submission.approved' ? on.approve :
    event === 'flair.requested'     ? on.submit  : // reuse the "new thing to review" toggle
    on.reject;

  if (!enabled || webhookUrls.length === 0) return;

  const meta = META[event];
  send({
    title:    meta.title(kindLabel(sub)),
    body:     sub.summary,
    tags:     meta.tags,
    priority: meta.priority,
    click:    adminUrl ? `${adminUrl}/admin/submissions` : undefined,
  });
}
