import { schedule as cronSchedule } from 'node-cron';
import type { FastifyInstance } from 'fastify';
import { config } from '../config';
import { errorMessage, notifyPollerFailure } from '../notify';
import { resolveTableId, teableCreateRecordById, teableFindRecords } from '../teable';

type Platform = 'iOS' | 'Android';

interface ApptopiaVersion {
  version: string;
  release_date: string; // YYYY-MM-DD
  description?: string;
}

// Apptopia's "Version History" panel. Each about page server-renders its data as
// JSON in a data-about-page-data attribute; versions are listed newest first.
const SOURCES: Record<Platform, string> = {
  iOS:     'https://apptopia.com/ios/app/386644958/about',
  Android: 'https://apptopia.com/google-play/app/com.nimblebit.pocketfrogs/about',
};

export const VERSION_FIELD_ID = 'fldUhvklcsbChGy9GFQ'; // primary — not unique: one row per platform
const DATE_FIELD_ID     = 'fldo9XCT2GpX8srHYsJ';
const PLATFORM_FIELD_ID = 'fldFnsLWl4pbH1HWl56'; // single select: iOS / Android (Both = legacy iTunes poller rows)
const VISIBLE_FIELD_ID  = 'fldmzgjllfJU8aFXao7';
const SOURCE_FIELD_ID   = 'fldcIBT2eT22GpT0wzW'; // single select: Apptopia Poller / iTunes Poller / Manual
const NOTES_FIELD_ID    = 'fldEf3IlPMbDRhgkVJl';

const SOURCE_NAME = 'Apptopia Poller';

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Android notes use <br> line breaks where iOS uses \n.
function cleanNotes(s: string | undefined): string {
  return (s ?? '').replace(/<br\s*\/?>/gi, '\n').trim();
}

async function fetchVersions(platform: Platform): Promise<ApptopiaVersion[]> {
  const res = await fetch(SOURCES[platform], {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; pfdb-submissions/1.0)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const m = html.match(/data-about-page-data="([^"]*)"/);
  if (!m) throw new Error('about-page data attribute not found');
  const data = JSON.parse(decodeEntities(m[1])) as { assets?: { app_about?: { versions?: ApptopiaVersion[] } } };
  const versions = data.assets?.app_about?.versions;
  if (!versions?.length) throw new Error('no versions in about-page data');
  // Guard against a changed or corrupted page producing junk rows — the poller
  // only ever creates records, so a bad scrape fails loudly instead.
  const [latest] = versions;
  if (!/^\d+(\.\d+)+$/.test(latest.version ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(latest.release_date ?? '')) {
    throw new Error(`unexpected latest entry: ${JSON.stringify(latest).slice(0, 200)}`);
  }
  return versions;
}

async function pollPlatform(
  platform: Platform,
  tableId: string,
  log: FastifyInstance['log'],
): Promise<void> {
  // Only the newest version is considered, matching the old iTunes poller.
  const [latest] = await fetchVersions(platform);

  // Each store gets its own row — builds usually track across platforms but
  // can differ in date and notes. Legacy "Both" rows (from the iTunes poller)
  // already cover this platform, so they count too.
  const existing = await teableFindRecords(tableId, {
    conjunction: 'and',
    filterSet: [
      { fieldId: VERSION_FIELD_ID, operator: 'is', value: latest.version },
      { fieldId: PLATFORM_FIELD_ID, operator: 'isAnyOf', value: [platform, 'Both'] },
    ],
  }, 1);
  if (existing.length > 0) {
    log.info(`Version poll: ${platform} v${latest.version} already recorded`);
    return;
  }

  await teableCreateRecordById(tableId, {
    [VERSION_FIELD_ID]:  latest.version,
    [DATE_FIELD_ID]:     latest.release_date,
    [PLATFORM_FIELD_ID]: platform,
    [VISIBLE_FIELD_ID]:  true,
    [SOURCE_FIELD_ID]:   SOURCE_NAME,
    [NOTES_FIELD_ID]:    cleanNotes(latest.description),
  }, { typecast: true });
  log.info(`Version poll: recorded ${platform} v${latest.version}`);
}

async function pollVersions(log: FastifyInstance['log']): Promise<void> {
  const failures: string[] = [];
  try {
    const tableId = await resolveTableId('Changelog');
    // Platforms are independent — one store failing doesn't block the other.
    await Promise.all((Object.keys(SOURCES) as Platform[]).map((p) =>
      pollPlatform(p, tableId, log).catch((err) => {
        log.warn({ err }, `Version poll: ${p} failed`);
        failures.push(`${p}: ${errorMessage(err)}`);
      }),
    ));
  } catch (err) {
    log.warn({ err }, 'Version poll: failed to resolve Changelog table');
    failures.push(`Changelog table: ${errorMessage(err)}`);
  }
  notifyPollerFailure('Version history', failures);
}

export function registerVersionPoller(log: FastifyInstance['log']): void {
  setTimeout(() => pollVersions(log), 20_000);
  cronSchedule(config.changelog.pollCron, () => pollVersions(log));
  log.info(`Version poller scheduled — cron=${config.changelog.pollCron}`);
}
