interface PendingDto {
  id: string;
  type: string;
  summary: string;
  submitterNote: string | null;
  screenshot: string | null;
  createdAt: string;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

// The note column now carries the attribution/source link. Render an http(s)
// value as a clickable "Source ↗" link; anything else as a plain quote.
function noteHtml(note: string | null): string {
  if (!note) return '';
  if (/^https?:\/\//i.test(note)) {
    return `<p class="note"><a href="${esc(note)}" target="_blank" rel="noopener noreferrer">Source ↗</a></p>`;
  }
  return `<p class="note">“${esc(note)}”</p>`;
}

// Server-rendered review page. Kept dependency-free: a sprinkle of inline JS
// calls the JSON approve/reject endpoints and removes the card on success.
export function renderAdminPage(rows: PendingDto[], username: string, logoutPath: string | null): string {
  const cards = rows
    .map(
      (r) => `
    <li class="card" data-id="${esc(r.id)}">
      <div class="card-main">
        <span class="badge">${esc(r.type)}</span>
        <strong class="summary">${esc(r.summary)}</strong>
        <span class="when">${esc(new Date(r.createdAt).toLocaleString())}</span>
        ${noteHtml(r.submitterNote)}
      </div>
      ${r.screenshot ? `<a href="${esc(r.screenshot)}" target="_blank" rel="noopener"><img class="thumb" src="${esc(r.screenshot)}" alt="screenshot"></a>` : ''}
      <div class="actions">
        <button class="approve" onclick="act(this,'approve')">Approve</button>
        <button class="reject" onclick="act(this,'reject')">Reject</button>
      </div>
      <p class="result" hidden></p>
    </li>`,
    )
    .join('');

  const empty = `<li class="empty">No pending submissions. 🎉</li>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pfdb submissions — review</title>
<style>
  :root{color-scheme:dark}
  body{font-family:system-ui,sans-serif;background:#1a1a1a;color:#eee;margin:0;padding:24px;max-width:840px;margin-inline:auto}
  header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:20px}
  h1{font-size:20px;margin:0}
  .who{color:#999;font-size:14px}
  ul{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:12px}
  .card{background:#242424;border:1px solid #333;border-radius:10px;padding:14px;display:grid;grid-template-columns:1fr auto;grid-template-areas:"main thumb" "actions thumb" "result result";gap:8px 14px;align-items:start}
  .card-main{grid-area:main}
  .badge{display:inline-block;font-size:11px;text-transform:uppercase;letter-spacing:.04em;background:#333;color:#bbb;border-radius:4px;padding:2px 7px;margin-right:8px;vertical-align:middle}
  .summary{font-size:16px}
  .when{display:block;color:#888;font-size:12px;margin-top:4px}
  .note{margin:8px 0 0;color:#cdb;font-style:italic;font-size:14px}
  .thumb{grid-area:thumb;max-width:140px;max-height:100px;border-radius:6px;border:1px solid #333;object-fit:cover}
  .actions{grid-area:actions;display:flex;gap:8px}
  button{padding:7px 16px;border:0;border-radius:6px;cursor:pointer;font-weight:600;font-family:inherit}
  .approve{background:#3a8f5b;color:#eafff0}
  .reject{background:#8f3a3a;color:#ffeaea}
  button:disabled{opacity:.5;cursor:default}
  .result{grid-area:result;margin:4px 0 0;font-size:14px}
  .result.ok{color:#7d7}
  .result.err{color:#e88}
  .empty{color:#999;text-align:center;padding:40px}
  a.logout{color:#9ab;font-size:14px}
</style></head><body>
  <header>
    <h1>Pending submissions <span class="who">— ${esc(username)}</span></h1>
    ${logoutPath ? `<form method="post" action="${esc(logoutPath)}" style="margin:0"><button class="logout" style="background:none;color:#9ab;padding:0">Log out</button></form>` : ''}
  </header>
  <ul id="list">${rows.length ? cards : empty}</ul>
<script>
async function act(btn, action){
  const card = btn.closest('.card');
  const id = card.dataset.id;
  const result = card.querySelector('.result');
  card.querySelectorAll('button').forEach(b => b.disabled = true);
  let body = null, headers = {};
  if (action === 'reject'){
    const note = prompt('Reason (optional):') || '';
    headers = {'Content-Type':'application/json'};
    body = JSON.stringify({ note });
  }
  try{
    const res = await fetch('/api/admin/'+id+'/'+action, { method:'POST', headers, body });
    const data = await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.detail || data.error || ('HTTP '+res.status));
    result.hidden = false; result.className = 'result ok';
    result.textContent = action === 'approve' ? ('Pushed ✓' + (data.pushed_ref ? ' ('+data.pushed_ref+')' : '')) : 'Rejected ✓';
    setTimeout(()=>card.remove(), 1200);
  }catch(err){
    result.hidden = false; result.className = 'result err'; result.textContent = String(err.message || err);
    card.querySelectorAll('button').forEach(b => b.disabled = false);
  }
}
</script>
</body></html>`;
}
