interface PendingDto {
  id: string;
  type: string;
  payload: string;
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
    <li class="card" data-id="${esc(r.id)}" data-payload="${esc(r.payload)}" data-screenshot="${esc(r.screenshot ?? '')}">
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
        <button class="edit-btn" onclick="openEdit(this)">Edit</button>
        ${r.screenshot ? `<button class="crop-btn" onclick="openCrop(this)">Crop</button>` : ''}
      </div>
      <p class="result" hidden></p>
      <div class="edit-form"></div>
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
  .card{background:#242424;border:1px solid #333;border-radius:10px;padding:14px;display:grid;grid-template-columns:1fr auto;grid-template-areas:"main thumb" "actions thumb" "result result" "edit edit";gap:8px 14px;align-items:start}
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
  .edit-btn{background:#444;color:#ccc}
  .crop-btn{background:#2a5a78;color:#c8eeff}
  #crop-dialog{background:#1e1e1e;border:1px solid #444;border-radius:10px;padding:16px;max-width:95vw;max-height:95vh;overflow:auto;color:#eee}
  #crop-dialog::backdrop{background:rgba(0,0,0,.75)}
  #crop-canvas{cursor:crosshair;display:block;max-width:100%;user-select:none}
  .crop-footer{display:flex;justify-content:space-between;align-items:center;margin-top:10px;gap:12px}
  .crop-hint{font-size:13px;color:#888}
  .edit-form{grid-area:edit;display:none;flex-direction:column;gap:10px;padding-top:10px;border-top:1px solid #333;margin-top:2px}
  .edit-form.open{display:flex}
  .edit-fields{display:grid;grid-template-columns:1fr 1fr;gap:6px 16px}
  .edit-label{display:flex;flex-direction:column;gap:3px;font-size:12px;color:#999}
  .edit-input{background:#111;border:1px solid #444;border-radius:4px;color:#eee;padding:5px 8px;font-size:13px;font-family:monospace;width:100%;box-sizing:border-box}
  .edit-screenshot{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:13px;color:#aaa}
  .edit-screenshot .thumb{max-width:80px;max-height:60px;border-radius:4px;border:1px solid #333}
  .edit-actions{display:flex;gap:8px}
  .save{background:#2a5fa8;color:#e0ecff}
  .cancel-edit{background:#3d3d3d;color:#bbb}
  #new-sub-banner{background:#2a5a30;color:#d4ffd9;padding:10px 16px;text-align:center;cursor:pointer;font-size:14px;font-weight:600;border-radius:6px;margin-bottom:12px;display:none}
</style></head><body>
  <dialog id="crop-dialog">
    <canvas id="crop-canvas"></canvas>
    <div class="crop-footer">
      <span class="crop-hint">Drag to select crop region</span>
      <div style="display:flex;gap:8px">
        <button onclick="applyCrop()" style="background:#2a5fa8;color:#e0ecff;padding:7px 16px;border:0;border-radius:6px;cursor:pointer;font-weight:600;font-family:inherit">Apply Crop</button>
        <button onclick="document.getElementById('crop-dialog').close()" style="background:#444;color:#ccc;padding:7px 16px;border:0;border-radius:6px;cursor:pointer;font-weight:600;font-family:inherit">Cancel</button>
      </div>
    </div>
  </dialog>
  <div id="new-sub-banner" onclick="location.reload()">New submission received — click to refresh</div>
  <header>
    <h1>Pending submissions <span class="who">— ${esc(username)}</span></h1>
    ${logoutPath ? `<form method="post" action="${esc(logoutPath)}" style="margin:0"><button class="logout" style="background:none;color:#9ab;padding:0">Log out</button></form>` : ''}
  </header>
  <ul id="list">${rows.length ? cards : empty}</ul>
<script>
(function(){
  const es=new EventSource('/api/admin/events');
  es.addEventListener('submission',()=>{
    if(document.querySelector('.edit-form.open')){
      document.getElementById('new-sub-banner').style.display='block';
    } else {
      location.reload();
    }
  });
})();
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
    setTimeout(()=>{card.remove();const l=document.getElementById('list');if(l&&!l.children.length)l.innerHTML='<li class="empty">No pending submissions. 🎉</li>';}, 1200);
  }catch(err){
    result.hidden = false; result.className = 'result err'; result.textContent = String(err.message || err);
    card.querySelectorAll('button').forEach(b => b.disabled = false);
  }
}
function escAttr(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);}
function openEdit(btn){
  const card=btn.closest('.card');
  const ef=card.querySelector('.edit-form');
  if(!ef.dataset.built){
    const payload=JSON.parse(card.dataset.payload||'{}');
    const ss=card.dataset.screenshot||'';
    let h='<div class="edit-fields">';
    for(const [k,v] of Object.entries(payload)){
      h+='<label class="edit-label">'+escAttr(k)+'<input class="edit-input" name="'+escAttr(k)+'" value="'+escAttr(String(v??''))+'"></label>';
    }
    h+='</div>';
    h+='<div class="edit-screenshot">'
      +(ss?'<a href="'+escAttr(ss)+'" target="_blank" rel="noopener"><img class="thumb" src="'+escAttr(ss)+'" alt="current screenshot"></a>':'')
      +'<label>'+(ss?'Replace':'Add')+' screenshot<input type="file" name="screenshot" accept="image/*" style="display:block;margin-top:4px"></label>'
      +(ss?'<label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" name="clearScreenshot"> Clear screenshot</label>':'')
      +'</div>';
    h+='<div class="edit-actions"><button class="save" onclick="saveEdit(this)">Save</button><button class="cancel-edit" onclick="cancelEdit(this)">Cancel</button></div>';
    h+='<p class="result" hidden></p>';
    ef.innerHTML=h;
    ef.dataset.built='1';
  }
  ef.classList.add('open');
  card.querySelector('.card-main').hidden=true;
  card.querySelector('.actions').hidden=true;
}
function cancelEdit(btn){
  const card=btn.closest('.card');
  card.querySelector('.edit-form').classList.remove('open');
  card.querySelector('.card-main').hidden=false;
  card.querySelector('.actions').hidden=false;
}
async function saveEdit(btn){
  const card=btn.closest('.card');
  const id=card.dataset.id;
  const ef=card.querySelector('.edit-form');
  const result=ef.querySelector('.result');
  ef.querySelectorAll('button').forEach(b=>b.disabled=true);
  const payload={};
  ef.querySelectorAll('.edit-input').forEach(inp=>{payload[inp.name]=inp.value;});
  const fd=new FormData();
  fd.append('payload',JSON.stringify(payload));
  const fi=ef.querySelector('input[type="file"]');
  if(fi?.files?.length) fd.append('screenshot',fi.files[0]);
  const clearCb=ef.querySelector('input[name="clearScreenshot"]');
  if(clearCb?.checked) fd.append('clearScreenshot','1');
  try{
    const res=await fetch('/api/admin/'+id,{method:'PATCH',body:fd});
    const data=await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error||'HTTP '+res.status);
    location.reload();
  }catch(err){
    result.hidden=false; result.className='result err'; result.textContent=String(err.message||err);
    ef.querySelectorAll('button').forEach(b=>b.disabled=false);
  }
}
let _cropId=null,_cropImg=null,_cropStart=null,_cropEnd=null,_dragging=false;
function openCrop(btn){
  const card=btn.closest('.card');
  const ss=card.dataset.screenshot; if(!ss) return;
  _cropId=card.dataset.id; _cropStart=_cropEnd=null;
  const canvas=document.getElementById('crop-canvas');
  _cropImg=new Image();
  _cropImg.onload=()=>{
    canvas.width=_cropImg.naturalWidth; canvas.height=_cropImg.naturalHeight;
    canvas.getContext('2d').drawImage(_cropImg,0,0);
  };
  _cropImg.src=ss;
  document.getElementById('crop-dialog').showModal();
}
function _cpPos(e){
  const c=document.getElementById('crop-canvas'),r=c.getBoundingClientRect();
  return {x:Math.round((e.clientX-r.left)*c.width/r.width),y:Math.round((e.clientY-r.top)*c.height/r.height)};
}
function _drawCrop(){
  const c=document.getElementById('crop-canvas'),ctx=c.getContext('2d');
  ctx.drawImage(_cropImg,0,0);
  if(!_cropStart||!_cropEnd) return;
  const x=Math.min(_cropStart.x,_cropEnd.x),y=Math.min(_cropStart.y,_cropEnd.y);
  const w=Math.abs(_cropEnd.x-_cropStart.x),h=Math.abs(_cropEnd.y-_cropStart.y);
  ctx.fillStyle='rgba(0,0,0,.55)'; ctx.fillRect(0,0,c.width,c.height);
  ctx.drawImage(_cropImg,x,y,w,h,x,y,w,h);
  ctx.strokeStyle='#fff'; ctx.lineWidth=2; ctx.strokeRect(x,y,w,h);
}
(function(){
  const c=document.getElementById('crop-canvas');
  c.addEventListener('mousedown',e=>{_dragging=true;_cropStart=_cpPos(e);_cropEnd={..._cropStart};_drawCrop();});
  c.addEventListener('mousemove',e=>{if(_dragging){_cropEnd=_cpPos(e);_drawCrop();}});
  c.addEventListener('mouseup',  e=>{_dragging=false;_cropEnd=_cpPos(e);_drawCrop();});
  document.getElementById('crop-dialog').addEventListener('click',function(e){if(e.target===this)this.close();});
})();
async function applyCrop(){
  if(!_cropStart||!_cropEnd) return;
  const c=document.getElementById('crop-canvas');
  const x=Math.min(_cropStart.x,_cropEnd.x),y=Math.min(_cropStart.y,_cropEnd.y);
  const w=Math.abs(_cropEnd.x-_cropStart.x),h=Math.abs(_cropEnd.y-_cropStart.y);
  if(w<5||h<5) return;
  const res=await fetch('/api/admin/'+_cropId+'/crop',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({left:x/c.width,top:y/c.height,right:(x+w)/c.width,bottom:(y+h)/c.height})});
  if(!res.ok){const d=await res.json().catch(()=>({}));alert(d.error||'Crop failed');return;}
  const d=await res.json();
  const card=document.querySelector('.card[data-id="'+_cropId+'"]');
  if(card&&d.screenshot){
    card.dataset.screenshot=d.screenshot;
    const img=card.querySelector('img.thumb'); if(img) img.src=d.screenshot+'?t='+Date.now();
    const a=card.querySelector('a[href]'); if(a&&a.contains(img)) a.href=d.screenshot;
    const ef=card.querySelector('.edit-form'); if(ef){ef.dataset.built='';ef.innerHTML='';}
  }
  document.getElementById('crop-dialog').close();
}
</script>
</body></html>`;
}
