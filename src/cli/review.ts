/**
 * Terminal reviewer — an alternative to the web admin page that needs no auth
 * setup. Run it inside the worker container (the active node's) so it shares
 * the database, screenshot bucket, and privileged Teable token.
 *
 *   npm run review            # interactive: approve/reject each pending item
 *   npm run review -- --list  # just print the pending queue and exit
 *   # deployed: docker compose exec worker node dist/cli/review.js
 */
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { listByStatus, getById, setStatus, deleteById, pool } from '../db';
import { getHandler } from '../handlers/registry';
import { deleteObject, getObject } from '../storage';

async function approve(id: string): Promise<void> {
  const row = await getById(id);
  if (!row || row.status !== 'pending') return;
  const handler = getHandler(row.type);
  if (!handler) throw new Error(`no handler for type "${row.type}"`);
  const payload = JSON.parse(row.payload);
  const data = row.screenshot ? await getObject(row.screenshot) : null;
  if (row.screenshot && !data) throw new Error(`screenshot ${row.screenshot} is missing from storage`);
  const ref = (await handler.pushDown(payload, {
    screenshot: row.screenshot && data ? { name: row.screenshot, data } : null,
    submitterSub: row.submitter_sub,
    submitterName: row.submitter_name,
  })) || null;
  await setStatus({
    id, status: 'pushed', reviewer_note: null, reviewed_at: new Date().toISOString(), pushed_ref: ref,
  });
  await deleteObject(row.screenshot_original);
  console.log(`  → pushed${ref ? ` (${ref})` : ''}`);
}

// Rejections aren't retained, matching the web admin page: row and screenshots go.
async function reject(id: string): Promise<void> {
  const row = await getById(id);
  if (!row) return;
  await deleteObject(row.screenshot_original);
  await deleteObject(row.screenshot);
  await deleteById(id);
  console.log('  → rejected');
}

async function main() {
  const pending = await listByStatus('pending');
  console.log(`\npfdb submissions — ${pending.length} pending\n`);

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
      if (r.screenshot) console.log(`  screenshot: ${r.screenshot} (view it on the web admin page)`);
      const ans = (await rl.question('  approve / reject / skip? [a/r/s] ')).trim().toLowerCase();
      if (ans === 'a') {
        try {
          await approve(r.id);
        } catch (e) {
          console.error(`  ✗ push failed: ${e instanceof Error ? e.message : e}`);
        }
      } else if (ans === 'r') {
        await reject(r.id);
      } else {
        console.log('  → skipped');
      }
    }
  } finally {
    rl.close();
  }
  console.log('\nDone.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
