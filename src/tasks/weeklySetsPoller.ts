import { schedule as cronSchedule } from 'node-cron';
import type { FastifyInstance } from 'fastify';
import { config } from '../config';
import {
  teableCreateRecordById,
  teableFieldValueExists,
  teableGetMaxNumber,
  teableBuildLookupMap,
} from '../teable';

const SETS_URL = 'https://nimbelbit.com/sets.txt';

const FROGS_TABLE_ID     = 'tblgaaUnZGx1i61RCOZ';
const FROG_READABLE_FIELD = 'fldYaxw2QNksOM7x79k'; // formula: "Base Secondary Breed"

const SET_DATE_FIELD_ID  = 'fld0g2OJuIM4fScLjfS';
const SET_NAME_FIELD_ID  = 'fldGxycvkmQqAM1ACak';
const SET_CHRON_FIELD_ID = 'fldaGzZa0KXnxP6HHYm';
const POTION_FIELD_ID    = 'fld4Ydpj2Q4PWFu5B5K';
const STAMP_FIELD_ID     = 'fldO6PVSdLA2sOAOkdc';

const FROG_FIELD_IDS = [
  'fldRIvXvkq7FC4w7BZ7', // Frog A
  'fldfc9j6HBvPwlnoUEj', // Frog B
  'fldAN1uTnT1uzz1TtgI', // Frog C
  'fldyxjg67HhOS6zRzgv', // Frog D
  'fldt55ft0SzhSfofuz9', // Frog E
  'fldH2VSg3XE8bmTLrXr', // Frog F
  'fldQ8hL7rZFBiAIoywb', // Frog G
  'fldHAl67k7o9GQwB1n4', // Frog H
] as const;

interface ParsedSet {
  weekId: string;  // YYYY-WW
  name: string;
  frogs: string[]; // readable names ("Base Secondary Breed"), expanded by count
}

function parseWeekId(raw: string): string {
  // YYYYWW → YYYY-WW
  return `${raw.slice(0, 4)}-${raw.slice(4).padStart(2, '0')}`;
}

function parseFile(text: string): ParsedSet[] {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const sets: ParsedSet[] = [];
  for (let i = 0; i + 2 < lines.length; i += 3) {
    const weekRaw  = lines[i];
    const name     = lines[i + 1];
    const frogsRaw = lines[i + 2];
    const frogs: string[] = [];
    for (const entry of frogsRaw.split(',')) {
      // Format: count:base:secondary:breed (breed may contain spaces)
      const parts = entry.trim().split(':');
      if (parts.length < 4) continue;
      const count     = parseInt(parts[0], 10);
      const base      = parts[1];
      const secondary = parts[2];
      const breed     = parts.slice(3).join(':');
      if (!count || !base || !secondary || !breed) continue;
      // Teable's Readable Name formula = "Base Secondary Breed"
      const readable = `${base} ${secondary} ${breed}`;
      for (let c = 0; c < count; c++) frogs.push(readable);
    }
    if (frogs.length > 0) sets.push({ weekId: parseWeekId(weekRaw), name, frogs });
  }
  return sets;
}

async function pollWeeklySets(log: FastifyInstance['log']): Promise<void> {
  try {
    const res = await fetch(SETS_URL);
    if (!res.ok) {
      log.warn({ status: res.status }, 'Weekly sets poll: HTTP error');
      return;
    }

    const sets = parseFile(await res.text());
    if (sets.length === 0) {
      log.warn('Weekly sets poll: no entries parsed from file');
      return;
    }

    const tableId = config.teable.tables.weekly;

    // Only check the most recent entry — the file is always appended chronologically,
    // and earlier entries may contain errors already corrected manually in the database.
    const latest = sets[sets.length - 1];
    const exists = await teableFieldValueExists(tableId, SET_DATE_FIELD_ID, latest.weekId);
    if (exists) {
      log.info(`Weekly sets poll: ${latest.weekId} already recorded`);
      return;
    }

    const frogIndex = await teableBuildLookupMap(FROGS_TABLE_ID, FROG_READABLE_FIELD);
    const frogIds: string[] = [];
    for (const readable of latest.frogs.slice(0, FROG_FIELD_IDS.length)) {
      const id = frogIndex.get(readable);
      if (!id) {
        log.warn({ readable, week: latest.weekId }, 'Weekly sets poll: unrecognized frog — aborting');
        return;
      }
      frogIds.push(id);
    }

    const nextChron = (await teableGetMaxNumber(tableId, SET_CHRON_FIELD_ID)) + 1;
    const fields: Record<string, unknown> = {
      [SET_NAME_FIELD_ID]:  latest.name,
      [SET_DATE_FIELD_ID]:  latest.weekId,
      [SET_CHRON_FIELD_ID]: nextChron,
      // Text file does not include reward amounts; update manually in Teable if needed
      [POTION_FIELD_ID]: 0,
      [STAMP_FIELD_ID]:  0,
    };
    for (let i = 0; i < frogIds.length; i++) {
      fields[FROG_FIELD_IDS[i]] = [{ id: frogIds[i] }];
    }

    await teableCreateRecordById(tableId, fields);
    log.info(`Weekly sets poll: created ${latest.weekId} "${latest.name}" (chron ${nextChron})`);
  } catch (err) {
    log.warn({ err }, 'Weekly sets poll: failed');
  }
}

export function registerWeeklySetsPoller(log: FastifyInstance['log']): void {
  setTimeout(() => pollWeeklySets(log), 30_000);
  cronSchedule(config.weeklySets.pollCron, () => pollWeeklySets(log));
  log.info(`Weekly sets poller scheduled — cron=${config.weeklySets.pollCron}`);
}
