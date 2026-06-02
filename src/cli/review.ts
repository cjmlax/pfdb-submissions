/**
 * Terminal reviewer — an alternative to the web admin page that needs no auth
 * setup. Run it on the host (or `docker compose exec`) with the same env so it
 * shares the SQLite file and the privileged Teable token.
 *
 *   npm run review            # interactive: approve/reject each pending item
 *   npm run review -- --list  # just print the pending queue and exit
 */
import readline from 'node:readline/promises';
import path from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { config } from '../config';
import { listByStatus, getById, queries, uploadsDir } from '../db';
import { getHandler } from '../handlers/registry';

async function approve(id: string): Promise<void> {
  const row = getById(id);
  if (!row || row.status !== 'pending') return;
  const handler = getHandler(row.type);
  if (!handler) throw new Error(`no handler for type "${row.type}"`);
  const payload = JSON.parse(row.payload);
  const screenshotPath = row.screenshot ? path.join(uploadsDir, row.screenshot) : null;
  const ref = (await handler.pushDown(payload, { screenshotPath })) || null;
  queries.setStatus.run({
    id, status: 'pushed', reviewer_note: null, reviewed_at: new Date().toISOString(), pushed_ref: ref,
  });
  console.log(`  → pushed${ref ? ` (${ref})` : ''}`);
}

function reject(id: string, note: string): void {
  queries.setStatus.run({
    id, status: 'rejected', reviewer_note: note || null, reviewed_at: new Date().toISOString(), pushed_ref: null,
  });
  console.log('  → rejected');
}

async function main() {
  const pending = listByStatus('pending');
  console.log(`\npfdb submissions — ${pending.length} pending (data: ${config.dataDir})\n`);

  if (pending.length === 0) return;

  if (process.argv.includes('--list')) {
    for (const r of pending) {
      console.log(`  [${r.id.slice(0, 8)}] ${r.summary}${r.screenshot ? '  📷' : ''}`);
    }
    return;
  }

  const rl = readline.createInterface({ input, output });
  try {
    for (const r of pending) {
      console.log(`\n${r.summary}`);
      if (r.submitter_note) console.log(`  note: “${r.submitter_note}”`);
      if (r.screenshot) console.log(`  screenshot: ${path.join(uploadsDir, r.screenshot)}`);
      const ans = (await rl.question('  approve / reject / skip? [a/r/s] ')).trim().toLowerCase();
      if (ans === 'a') {
        try {
          await approve(r.id);
        } catch (e) {
          console.error(`  ✗ push failed: ${e instanceof Error ? e.message : e}`);
        }
      } else if (ans === 'r') {
        const note = await rl.question('  reason (optional): ');
        reject(r.id, note.trim());
      } else {
        console.log('  → skipped');
      }
    }
  } finally {
    rl.close();
  }
  console.log('\nDone.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
