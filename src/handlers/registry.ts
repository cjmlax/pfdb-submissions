import type { SubmissionHandler } from '../types';
import { comboHandler } from './combo';

// Register every submission type here. To add one later:
//   1. write a handler file like combo.ts
//   2. add it to this list
//   3. add a matching form on the website
// Nothing else in the worker needs to change.
const ALL: SubmissionHandler<any>[] = [comboHandler];

const byType = new Map<string, SubmissionHandler<any>>(ALL.map((h) => [h.type, h]));

export function getHandler(type: string): SubmissionHandler<any> | null {
  return byType.get(type) ?? null;
}

export function listHandlers(): SubmissionHandler<any>[] {
  return ALL;
}
