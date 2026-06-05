import fs from 'node:fs';
import { schedule as cronSchedule } from 'node-cron';
import type { FastifyInstance } from 'fastify';
import { config } from '../config';

interface ChangelogEntry {
  version: string;
  date: string;
  platform: 'ios' | 'android' | 'both';
  notes: string;
}

interface ItunesResult {
  version: string;
  releaseNotes?: string;
  currentVersionReleaseDate: string;
}

const ITUNES_ID = '386644958';

function loadChangelog(): ChangelogEntry[] {
  try {
    return JSON.parse(fs.readFileSync(config.changelog.path, 'utf8')) as ChangelogEntry[];
  } catch {
    return [];
  }
}

function saveChangelog(entries: ChangelogEntry[]): void {
  fs.writeFileSync(config.changelog.path, JSON.stringify(entries, null, 2) + '\n');
}

async function pollItunes(log: FastifyInstance['log']): Promise<void> {
  try {
    const res = await fetch(`https://itunes.apple.com/lookup?id=${ITUNES_ID}`);
    if (!res.ok) {
      log.warn({ status: res.status }, 'iTunes poll: HTTP error');
      return;
    }
    const data = await res.json() as { results?: ItunesResult[] };
    const r = data.results?.[0];
    if (!r) {
      log.warn({}, 'iTunes poll: no result in response');
      return;
    }

    const entries = loadChangelog();
    if (entries[0]?.version === r.version) {
      log.info('iTunes poll: version unchanged, skipping');
      return;
    }

    entries.unshift({
      version: r.version,
      date: r.currentVersionReleaseDate,
      platform: 'ios',
      notes: r.releaseNotes ?? '',
    });
    saveChangelog(entries);
    log.info(`iTunes poll: recorded v${r.version}`);
  } catch (err) {
    log.warn({ err }, 'iTunes poll: fetch failed');
  }
}

export function registerItunesPoller(log: FastifyInstance['log']): void {
  if (!config.changelog.path) {
    log.info('iTunes poller disabled — set CHANGELOG_PATH to enable');
    return;
  }
  setTimeout(() => pollItunes(log), 20_000);
  cronSchedule(config.changelog.pollCron, () => pollItunes(log));
  log.info(`iTunes poller scheduled — cron=${config.changelog.pollCron}, path=${config.changelog.path}`);
}
