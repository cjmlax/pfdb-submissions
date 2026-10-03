import { schedule as cronSchedule } from 'node-cron';
import type { FastifyInstance } from 'fastify';
import { config } from '../config';
import { resolveTableId, teableCreateRecordById, teableRecordMatches } from '../teable';

interface ItunesResult {
  version: string;
  releaseNotes?: string;
  currentVersionReleaseDate: string;
}

const ITUNES_ID = '386644958';

const VERSION_FIELD_ID  = 'fldUhvklcsbChGy9GFQ'; // primary — not unique; Version + Platform identifies an entry
const DATE_FIELD_ID     = 'fldo9XCT2GpX8srHYsJ';
const PLATFORM_FIELD_ID = 'fldFnsLWl4pbH1HWl56'; // single select: Both / iOS / Android
const VISIBLE_FIELD_ID  = 'fldmzgjllfJU8aFXao7';
const SOURCE_FIELD_ID   = 'fldcIBT2eT22GpT0wzW'; // single select: iTunes Poller / Manual
const NOTES_FIELD_ID    = 'fldEf3IlPMbDRhgkVJl';

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

    const tableId = await resolveTableId('Changelog');
    const exists = await teableRecordMatches(tableId, {
      [VERSION_FIELD_ID]:  r.version,
      [PLATFORM_FIELD_ID]: 'iOS',
    });
    if (exists) {
      log.info(`iTunes poll: v${r.version} (iOS) already recorded`);
      return;
    }

    await teableCreateRecordById(tableId, {
      [VERSION_FIELD_ID]:  r.version,
      [DATE_FIELD_ID]:     r.currentVersionReleaseDate,
      [PLATFORM_FIELD_ID]: 'iOS',
      [VISIBLE_FIELD_ID]:  true,
      [SOURCE_FIELD_ID]:   'iTunes Poller',
      [NOTES_FIELD_ID]:    r.releaseNotes ?? '',
    });
    log.info(`iTunes poll: recorded v${r.version}`);
  } catch (err) {
    log.warn({ err }, 'iTunes poll: failed');
  }
}

export function registerItunesPoller(log: FastifyInstance['log']): void {
  setTimeout(() => pollItunes(log), 20_000);
  cronSchedule(config.changelog.pollCron, () => pollItunes(log));
  log.info(`iTunes poller scheduled — cron=${config.changelog.pollCron}`);
}
