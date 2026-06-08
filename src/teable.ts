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

// Table IDs resolved by display name from the base's table list, cached for the
// process lifetime. Lets the worker discover tables instead of hardcoding their
// IDs in config — the names are stable and human-readable.
let tableIdByName: Map<string, string> | null = null;

export async function resolveTableId(name: string): Promise<string> {
  if (!tableIdByName) {
    const url = `${config.teable.baseUrl}/api/base/${config.teable.baseId}/table`;
    const res = await fetch(url, { headers: authHeader() });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Teable table list failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const tables = (await res.json()) as { id: string; name: string }[];
    tableIdByName = new Map(tables.map((t) => [t.name, t.id]));
  }
  const id = tableIdByName.get(name);
  if (!id) throw new Error(`Teable table "${name}" not found in base ${config.teable.baseId}.`);
  return id;
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

// Uploads a local file to an existing record's attachment field.
// Must be called after the record is created — Teable's upload endpoint is
// scoped to a specific record and field, not a free-standing upload.
export async function teableUploadAttachmentToRecord(
  tableId: string,
  recordId: string,
  fieldId: string,
  filePath: string,
): Promise<void> {
  const data = await readFile(filePath);
  const name = basename(filePath);
  const ext = name.split('.').pop()?.toLowerCase();
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
  const form = new FormData();
  form.append('file', new Blob([data], { type: mime }), name);
  const url = `${config.teable.baseUrl}/api/table/${tableId}/record/${recordId}/${fieldId}/uploadAttachment`;
  const res = await fetch(url, { method: 'POST', headers: authHeader(), body: form });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Teable attachment upload failed (${res.status}): ${text.slice(0, 300)}`);
  }
}

// Returns true if any record in the table has the given exact value in fieldId.
// Uses a server-side filter so only one record is fetched even on large tables.
export async function teableFieldValueExists(
  tableId: string,
  fieldId: string,
  value: string,
): Promise<boolean> {
  const filter = JSON.stringify({ conjunction: 'and', filterSet: [{ fieldId, operator: 'is', value }] });
  const url = `${config.teable.baseUrl}/api/table/${tableId}/record?fieldKeyType=id&take=1&filter=${encodeURIComponent(filter)}`;
  const res = await fetch(url, { headers: authHeader() });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Teable filter query failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as { records?: unknown[] };
  return (data.records?.length ?? 0) > 0;
}

// Finds the current maximum numeric value of a field across all records in a table.
// Used to compute the next sequential value (max + 1) before creating a new record.
export async function teableGetMaxNumber(tableId: string, fieldId: string): Promise<number> {
  const url = `${config.teable.baseUrl}/api/table/${tableId}/record?fieldKeyType=id&take=1000`;
  const res = await fetch(url, { headers: authHeader() });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Teable record query failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as { records?: { fields?: Record<string, unknown> }[] };
  let max = 0;
  for (const rec of data.records ?? []) {
    const val = rec.fields?.[fieldId];
    if (typeof val === 'number' && val > max) max = val;
  }
  return max;
}

// Fetches all records in a table (paginated) and returns a Map of one field's
// string value to the Teable record ID. Useful for building lookup indexes.
export async function teableBuildLookupMap(
  tableId: string,
  valueFieldId: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let offset = 0;
  const take = 1000;
  while (true) {
    const url = `${config.teable.baseUrl}/api/table/${tableId}/record?fieldKeyType=id&take=${take}&skip=${offset}`;
    const res = await fetch(url, { headers: authHeader() });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Teable record fetch failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as { records?: { id: string; fields?: Record<string, unknown> }[] };
    const records = data.records ?? [];
    for (const rec of records) {
      const val = rec.fields?.[valueFieldId];
      if (typeof val === 'string' && val) map.set(val, rec.id);
    }
    if (records.length < take) break;
    offset += take;
  }
  return map;
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
