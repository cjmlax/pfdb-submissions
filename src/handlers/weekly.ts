import { z } from 'zod';
import type { SubmissionHandler } from '../types';
import { teableCreateRecordById, teableFieldValueExists, teableGetMaxNumber } from '../teable';
import { config } from '../config';

// Mirrors getCurrentISOWeek() on the frontend. Calculated at approval time so
// the stored date always reflects the actual active week, not the submission date.
function getCurrentISOWeek(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: 'numeric', day: 'numeric',
    weekday: 'long', hour: 'numeric', hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  const year    = parseInt(get('year'),  10);
  const month   = parseInt(get('month'), 10);
  const day     = parseInt(get('day'),   10);
  const weekday = get('weekday');
  const hour    = parseInt(get('hour') || '12', 10) % 24;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (weekday === 'Monday' && hour < 14) d.setUTCDate(d.getUTCDate() - 7);
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-${String(weekNo).padStart(2, '0')}`;
}

const SET_NAME_FIELD_ID  = 'fldGxycvkmQqAM1ACak';
const SET_DATE_FIELD_ID  = 'fld0g2OJuIM4fScLjfS';
const SET_CHRON_FIELD_ID = 'fldaGzZa0KXnxP6HHYm';
const STAMP_FIELD_ID_A   = 'fld4Ydpj2Q4PWFu5B5K'; // Potion Reward
const STAMP_FIELD_ID_B   = 'fldO6PVSdLA2sOAOkdc'; // Stamp Reward

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

export async function getWeeklyStatus(): Promise<{ week: string; exists: boolean }> {
  const week = getCurrentISOWeek();
  const exists = await teableFieldValueExists(config.teable.tables.weekly, SET_DATE_FIELD_ID, week);
  return { week, exists };
}

export const weeklySchema = z.object({
  setName: z.string().min(1).max(120),
  reward:  z.number().int().positive(),
  frogs:   z.array(z.string().min(1).max(40)).min(4).max(8), // Teable record IDs
});

export type WeeklyPayload = z.infer<typeof weeklySchema>;

export const weeklyHandler: SubmissionHandler<WeeklyPayload> = {
  type:  'weekly',
  label: 'Weekly Set',
  schema: weeklySchema,
  summarize: (p) =>
    `${p.setName} — ${p.frogs.length} frog${p.frogs.length !== 1 ? 's' : ''}, ${p.reward} stamps`,

  async pushDown(p) {
    const tableId   = config.teable.tables.weekly;
    const nextChron = (await teableGetMaxNumber(tableId, SET_CHRON_FIELD_ID)) + 1;
    const fields: Record<string, unknown> = {
      [SET_NAME_FIELD_ID]:  p.setName,
      [SET_DATE_FIELD_ID]:  getCurrentISOWeek(),
      [SET_CHRON_FIELD_ID]: nextChron,
      [STAMP_FIELD_ID_A]:   p.reward,
      [STAMP_FIELD_ID_B]:   p.reward,
    };
    for (let i = 0; i < p.frogs.length; i++) {
      fields[FROG_FIELD_IDS[i]] = [{ id: p.frogs[i] }];
    }
    return teableCreateRecordById(tableId, fields);
  },
};
