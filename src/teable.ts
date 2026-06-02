import { config } from './config';

// Minimal privileged Teable client. The write token lives only in this process,
// never in the browser — which is the entire reason this worker exists.

export async function teableCreateRecord(
  tableId: string,
  fields: Record<string, unknown>,
): Promise<string> {
  if (!config.teable.token) {
    throw new Error('TEABLE_TOKEN is not set — cannot push approved submissions to Teable.');
  }
  const url = `${config.teable.baseUrl}/api/table/${tableId}/record`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.teable.token}`,
    },
    // fieldKeyType: 'name' lets handlers reference fields by their display name
    // ("Frog 1", "Frog 2", …), matching how the website reads these tables.
    body: JSON.stringify({ fieldKeyType: 'name', records: [{ fields }] }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Teable create failed (${res.status}): ${text.slice(0, 500)}`);
  }
  const data = (await res.json()) as { records?: { id?: string }[] };
  return data.records?.[0]?.id ?? '';
}
