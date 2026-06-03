import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { config } from './config';

// Minimal privileged Teable client. The write token lives only in this process,
// never in the browser — which is the entire reason this worker exists.

function authHeader(): Record<string, string> {
  if (!config.teable.token) {
    throw new Error('TEABLE_TOKEN is not set — cannot talk to Teable.');
  }
  return { Authorization: `Bearer ${config.teable.token}` };
}

interface TeableField {
  id: string;
  name: string;
  dbFieldName: string;
}

// Field metadata is cached per table for the process lifetime — field ids are
// stable, and this lets us write records by field id (unambiguous) instead of by
// display name, which has historically drifted.
const fieldCache = new Map<string, TeableField[]>();

async function getFields(tableId: string): Promise<TeableField[]> {
  const cached = fieldCache.get(tableId);
  if (cached) return cached;
  const url = `${config.teable.baseUrl}/api/table/${tableId}/field`;
  const res = await fetch(url, { headers: authHeader() });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Teable field list failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const fields = (await res.json()) as TeableField[];
  fieldCache.set(tableId, fields);
  return fields;
}

// Identify a field either by its display name or its dbFieldName — whichever we
// can state with confidence for a given field.
export type FieldRef = { name: string } | { dbFieldName: string };

export async function resolveFieldId(tableId: string, ref: FieldRef): Promise<string> {
  const fields = await getFields(tableId);
  const match = fields.find((f) =>
    'name' in ref ? f.name === ref.name : f.dbFieldName === ref.dbFieldName,
  );
  if (!match) {
    throw new Error(`Field ${JSON.stringify(ref)} not found in table ${tableId}.`);
  }
  return match.id;
}

// Uploads a local file to Teable's attachment endpoint and returns the
// attachment descriptor (token, name, size, mimetype) ready to embed in a
// record's attachment field array.
export async function teableUploadAttachment(filePath: string): Promise<Record<string, unknown>> {
  const data = await readFile(filePath);
  const name = basename(filePath);
  const ext = name.split('.').pop()?.toLowerCase();
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
  const form = new FormData();
  form.append('file', new Blob([data], { type: mime }), name);
  const url = `${config.teable.baseUrl}/api/attachments/upload`;
  const res = await fetch(url, { method: 'POST', headers: authHeader(), body: form });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Teable attachment upload failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<Record<string, unknown>>;
}

// Creates a record using field IDs (fieldKeyType: 'id'), so the keys are not
// sensitive to display-name renames. Returns the new record id.
export async function teableCreateRecordById(
  tableId: string,
  fieldsById: Record<string, unknown>,
): Promise<string> {
  const url = `${config.teable.baseUrl}/api/table/${tableId}/record`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ fieldKeyType: 'id', records: [{ fields: fieldsById }] }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Teable create failed (${res.status}): ${text.slice(0, 500)}`);
  }
  const data = (await res.json()) as { records?: { id?: string }[] };
  return data.records?.[0]?.id ?? '';
}
