const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const state = { path: '', files: [], filePage: 1, sharePage: 1, shares: [], shareQuery: '', pageSize: 10 };
let adminPassword = sessionStorage.getItem('fileshare_admin') || '';
let guestToken = sessionStorage.getItem('fileshare_guest') || '';
let guestMode = !!guestToken;

function esc(s){return String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function bytes(n){if(n===null||n===undefined)return '—';if(n<1024)return n+' B';const u=['KB','MB','GB','TB'];let i=-1,v=n;while(v>=1024&&i<u.length-1){v/=1024;i++;}return v.toFixed(v>=100?0:1)+' '+u[i];}
function date(v){return v?new Date(v).toLocaleString('zh-CN',{hour12:false}):'—';}
function toast(msg){const el=$('#toast');el.textContent=msg;el.classList.add('show');clearTimeout(window.__toast);window.__toast=setTimeout(()=>el.classList.remove('show'),2600);}
function openModal(title,body,foot=''){ $('#modalTitle').textContent=title;$('#modalBody').innerHTML=body;$('#modalFoot').innerHTML=foot;$('#modal').classList.add('show'); }
function closeModal(){$('#modal').classList.remove('show');}
$('#modalClose').onclick=closeModal;$('#modal').onclick=e=>{if(e.target.id==='modal')closeModal();};
function copyText(text){if(navigator.clipboard?.writeText)return navigator.clipboard.writeText(text);const t=document.createElement('textarea');t.value=text;document.body.appendChild(t);t.select();document.execCommand('copy');t.remove();return Promise.resolve();}

async function api(url, options={}){
  const headers={...(options.headers||{})};
  if(adminPassword) headers['X-Admin-Password']=adminPassword;
  if(guestMode && guestToken) headers['X-Guest-Token']=guestToken;
  const r=await fetch(url,{...options,headers});
  const d=await r.json().catch(()=>({}));
  if(!r.ok) throw Object.assign(new Error(d.error||`请求失败 (${r.status})`),{status:r.status});
  return d;
}
async function login(){
  return new Promise(resolve=>{
    openModal('登录 FileShare',`<div class="login-logo">☁</div><h3 class="login-title">欢迎使用 FileShare</h3><div class="login-sub">管理员可管理文件；来宾账号仅可浏览和下载</div><div class="field"><label>管理员密码</label><input class="input" id="loginPassword" type="password" autofocus placeholder="请输入管理员密码"></div><div id="loginError" class="muted" style="color:#dc2626;min-height:20px"></div>`, `<button class="outline" id="guestLoginBtn">来宾访问</button><button class="primary" id="loginSubmit">进入管理台</button>`);
    const submit=async()=>{const p=$('#loginPassword').value;if(!p)return;try{guestMode=false;guestToken='';sessionStorage.removeItem('fileshare_guest');await fetch('/api/guest/logout',{method:'POST'}).catch(()=>{});await api('/api/admin/check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:p})});adminPassword=p;sessionStorage.setItem('fileshare_admin',p);closeModal();resolve(true);}catch(e){$('#loginError').textContent='管理员密码错误，请重新输入';$('#loginPassword').focus();}};
    $('#loginSubmit').onclick=submit;$('#loginPassword').addEventListener('keydown',e=>{if(e.key==='Enter')submit();});
    $('#guestLoginBtn').onclick=()=>showGuestLogin(resolve);
  });
}
function showGuestLogin(resolve){
  openModal('来宾登录',`<div class="login-logo">↓</div><h3 class="login-title">临时网盘</h3><div class="login-sub">来宾账号只能浏览和下载文件，不能上传、删除或修改文件</div><div class="field"><label>来宾账号</label><input class="input" id="guestUsername" autofocus placeholder="请输入账号"></div><div class="field"><label>来宾密码</label><input class="input" id="guestPassword" type="password" placeholder="请输入密码"></div><div id="guestLoginError" class="muted" style="color:#dc2626;min-height:20px"></div>`,`<button class="outline" id="guestBack">返回管理员</button><button class="primary" id="guestSubmit">进入网盘</button>`);
  $('#guestBack').onclick=()=>login().then(resolve);
  $('#guestSubmit').onclick=async()=>{try{const r=await fetch('/api/guest/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:$('#guestUsername').value.trim(),password:$('#guestPassword').value})});const d=await r.json();if(!r.ok)throw new Error(d.error||'登录失败');adminPassword='';sessionStorage.removeItem('fileshare_admin');guestToken=d.token;guestMode=true;sessionStorage.setItem('fileshare_guest',guestToken);closeModal();applyRoleUI();resolve(true);loadGuestFiles();}catch(e){$('#guestLoginError').textContent=e.message;}};
}
async function ensureAdmin(){
  guestMode=false;
  if(adminPassword){try{await api('/api/files?path=');applyRoleUI();return true;}catch(e){if(e.status!==401)throw e;adminPassword='';sessionStorage.removeItem('fileshare_admin');}}
  return login();
}
async function ensureGuest(){
  if(!guestToken){return login();}
  guestMode=true;
  try{await api('/api/guest/files?path=');applyRoleUI();return true;}catch(e){guestToken='';sessionStorage.removeItem('fileshare_guest');return login();}
}
function applyRoleUI(){
  const guest=guestMode;
  $('#uploadBtn').style.display=guest?'none':'';$('#folderBtn').style.display=guest?'none':'';$('#newFolderBtn').style.display=guest?'none':'';
  $('#settingsTop').style.display=guest?'none':'';$('#settingsCaret').style.display=guest?'none':'';if(guest){$('#settingsMenu').classList.remove('show');}
  const shareNav=document.querySelector('[data-view="shares"]');if(shareNav)shareNav.style.display=guest?'none':'';
}
async function loadGuestFiles(){
  try{const d=await api('/api/guest/files?path='+encodeURIComponent(state.path));state.files=d.items;renderFiles();renderCrumbs();}
  catch(e){if(e.status===401){guestToken='';sessionStorage.removeItem('fileshare_guest');guestMode=false;await login();}else toast(e.message);}
}

function setView(name){
  $$('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.view===name));
  $$('.view').forEach(v=>v.classList.toggle('active',v.id===`view-${name}`));
  if(name==='files') guestMode?loadGuestFiles():loadFiles(); if(name==='shares'&&!guestMode)loadShares();
}
$$('.nav-item').forEach(b=>b.onclick=()=>setView(b.dataset.view));
function closeSettingsMenu(){const m=$('#settingsMenu');if(m)m.classList.remove('show');}
function toggleSettingsMenu(){if(guestMode)return;$('#settingsMenu').classList.toggle('show');}
$('#settingsTop').onclick=toggleSettingsMenu;
$('#settingsCaret').onclick=toggleSettingsMenu;
document.addEventListener('click',e=>{if(!e.target.closest('.settings-wrap'))closeSettingsMenu();});
$$('[data-menu-action]').forEach(b=>b.onclick=async()=>{const a=b.dataset.menuAction;closeSettingsMenu();if(a==='storage')return showSettings('storage');if(a==='guests')return showSettings('guests');if(a==='shares'){setView('shares');return;}if(a==='system'){document.body.classList.toggle('dim');localStorage.setItem('fileshare_dim',document.body.classList.contains('dim'));toast(document.body.classList.contains('dim')?'已切换为深色模式':'已切换为浅色模式');return;}if(a==='password')return showSettings('password');if(a==='logout'){if(guestMode){guestToken='';guestMode=false;sessionStorage.removeItem('fileshare_guest');}else{adminPassword='';sessionStorage.removeItem('fileshare_admin');}location.reload();}});
$('#themeBtn')?.remove();
if(localStorage.getItem('fileshare_dim')==='true')document.body.classList.add('dim');
const topSearch=$('#fileSearchTop');
function filterCurrentFiles(){const q=(topSearch?.value||'').trim().toLowerCase();if(!q){renderFiles();return;}const original=state.files;state.files=original.filter(x=>x.name.toLowerCase().includes(q)||x.path.toLowerCase().includes(q));state.filePage=1;renderFiles();state.files=original;}
if(topSearch){topSearch.oninput=()=>filterCurrentFiles();topSearch.onkeydown=e=>{if(e.key==='Enter')filterCurrentFiles();};}


function fileIcon(item){
  if(item.type==='dir')return ['📁','folder-icon'];
  const ext=item.name.split('.').pop().toLowerCase();
  if(['jpg','jpeg','png','gif','webp','svg'].includes(ext))return ['🖼️',''];
  if(['zip','rar','7z','tar','gz'].includes(ext))return ['🗜️',''];
  if(['mp4','mkv','avi','mov','webm'].includes(ext))return ['🎬',''];
  if(['mp3','wav','flac','aac'].includes(ext))return ['🎵',''];
  if(['pdf'].includes(ext))return ['📕',''];
  if(['doc','docx','txt','md'].includes(ext))return ['📄',''];
  return ['📄',''];
}
function renderCrumbs(){
  const parts=state.path?state.path.split('/').filter(Boolean):[];
  let html=`<span class="crumb" data-path="">根目录</span>`;
  let acc='';parts.forEach((p,i)=>{acc+=`${acc?'/':''}${p}`;html+=`<span>›</span><span class="crumb ${i===parts.length-1?'current':''}" data-path="${esc(acc)}">${esc(p)}</span>`;});
  $('#crumbs').innerHTML=html;$$('.crumb').forEach(c=>c.onclick=()=>{state.path=c.dataset.path;state.filePage=1;loadFiles();});
}
async function loadStorage(){
  try{
    const d=await api('/api/storage');
    $('#storageUsed').textContent=d.maxStorageGB ? `${d.usedText} / ${d.maxStorageText}` : d.usedText;
    $('#fileCount').textContent=d.files;
    $('#storageBar').style.width=d.maxStorageGB ? `${d.percent}%` : '12%';
  }catch{}
}
async function loadFiles(){
  try{const d=await api('/api/files?path='+encodeURIComponent(state.path));state.files=d.items;renderFiles();renderCrumbs();loadStorage();}
  catch(e){if(e.status===401){adminPassword='';sessionStorage.removeItem('fileshare_admin');await login();loadFiles();}else toast(e.message);}
}
function renderFiles(){
  const start=(state.filePage-1)*state.pageSize;const rows=state.files.slice(start,start+state.pageSize);
  $('#fileRows').innerHTML=rows.length?rows.map(x=>{
    let actions='';
    if(guestMode){ actions=`<button class="small-btn" data-act="download" data-path="${esc(x.path)}">↓ 下载</button>${x.type==='dir'?'<button class="small-btn" data-act="open" data-path="'+esc(x.path)+'">打开</button>':''}`; }
    else { actions=`<button class="small-btn" data-act="download" data-path="${esc(x.path)}">↓ 下载</button><button class="small-btn" data-act="share" data-path="${esc(x.path)}">↗ 分享</button>${x.type==='dir'?'<button class="small-btn" data-act="open" data-path="'+esc(x.path)+'">打开</button>':''}<button class="small-btn" data-act="move" data-path="${esc(x.path)}">移动</button><button class="small-btn" data-act="rename" data-path="${esc(x.path)}">✎</button><button class="small-btn red" data-act="delete" data-path="${esc(x.path)}">⌫</button>`; }
    return `<tr data-row-type="${x.type}" data-row-path="${esc(x.path)}" title="${x.type==='dir'?'双击进入文件夹':''}"><td><div class="file-name">${x.type==='dir'?'<span class="folder-emoji">📁</span>':''}<span class="file-main" title="${esc(x.name)}">${esc(x.name)}</span></div></td><td>${x.type==='dir'?'文件夹':'文件'}</td><td>${x.type==='dir'?'—':bytes(x.size)}</td><td>${date(x.mtime)}</td><td><div class="row-actions">${actions}</div></td></tr>`;
  }).join(''):`<tr><td colspan="5"><div class="empty">📂<br><br>这个文件夹还是空的</div></td></tr>`;
  const pages=Math.max(1,Math.ceil(state.files.length/state.pageSize));state.filePage=Math.min(state.filePage,pages);let p='';if(pages>1){for(let i=1;i<=pages;i++)p+=`<button class="page-btn ${i===state.filePage?'active':''}" data-file-page="${i}">${i}</button>`;}$('#filePager').innerHTML=state.files.length?`共 ${state.files.length} 项 ${p}`:'';$$('[data-file-page]').forEach(b=>b.onclick=()=>{state.filePage=+b.dataset.filePage;renderFiles();});
}
$('#fileRows').onclick=async e=>{const b=e.target.closest('[data-act]');if(!b)return;const act=b.dataset.act,p=b.dataset.path;if(act==='open'){state.path=p;state.filePage=1;guestMode?loadGuestFiles():loadFiles();}if(act==='download')downloadPath(p);if(guestMode)return;if(act==='share')showShareCreate(p);if(act==='move')showMove(p);if(act==='rename')showRename(p);if(act==='delete')removePath(p);};
$('#fileRows').ondblclick=e=>{if(e.target.closest('button,[data-act]'))return;const row=e.target.closest('tr[data-row-type="dir"]');if(!row)return;state.path=row.dataset.rowPath;state.filePage=1;loadFiles();};
$('#refreshBtn').onclick=loadFiles;
$('#uploadBtn').onclick=()=>$('#fileInput').click();$('#folderBtn').onclick=()=>$('#folderInput').click();
$('#newFolderBtn').onclick=showNewFolder;
$('#fileInput').onchange=e=>uploadFiles(e.target.files);$('#folderInput').onchange=e=>uploadFiles(e.target.files);
async function uploadFiles(files){
  if(!files?.length)return;
  const list=[...files];
  const totalBytes=list.reduce((n,f)=>n+(f.size||0),0);
  const fd=new FormData();
  for(const f of list)fd.append('files',f,f.webkitRelativePath||f.name);
  fd.append('path',state.path||'');
  const title=list.length>1?`上传 ${list.length} 个文件`:`上传文件`;
  openUploadProgress(title,totalBytes,list.length);
  try{
    const d=await uploadWithProgress(fd,(loaded,total)=>updateUploadProgress(loaded,total));
    updateUploadProgress(totalBytes,totalBytes,true);
    $('#uploadProgressText').textContent=`上传完成，共 ${d.uploaded||list.length} 个文件`;
    $('#uploadProgressSub').textContent='文件正在保存，请稍候…';
    setTimeout(()=>{closeModal();eReset();toast(`上传完成，共 ${d.uploaded||list.length} 个文件`);loadFiles();},500);
  }catch(e){
    $('#uploadProgressText').textContent='上传失败';
    $('#uploadProgressSub').textContent=e.message||'上传失败';
    $('#uploadProgressBar').classList.add('error');
    $('#uploadProgressClose').disabled=false;
    toast(e.message||'上传失败');
  }
}
function openUploadProgress(title,total,count){
  openModal(title,`<div class="upload-progress-wrap"><div class="upload-progress-head"><b id="uploadProgressText">准备上传…</b><span id="uploadProgressPercent">0%</span></div><div class="upload-progress"><i id="uploadProgressBar"></i></div><div class="upload-progress-info"><span id="uploadProgressSub">正在准备 ${count} 个文件（${bytes(total)}）</span><span id="uploadProgressSize">0 B / ${bytes(total)}</span></div></div>`,`<button class="outline" id="uploadProgressClose">关闭</button>`);
  $('#uploadProgressClose').disabled=true;
  $('#uploadProgressClose').onclick=()=>closeModal();
}
function updateUploadProgress(loaded,total,done=false){
  const pct=total?Math.min(100,Math.round(loaded/total*100)):0;
  const bar=$('#uploadProgressBar');if(!bar)return;
  bar.style.width=pct+'%';
  $('#uploadProgressPercent').textContent=pct+'%';
  $('#uploadProgressSize').textContent=`${bytes(loaded)} / ${bytes(total)}`;
  $('#uploadProgressSub').textContent=done?'上传完成，正在处理…':'正在上传…';
}
function uploadWithProgress(fd,onProgress){
  return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();
    xhr.open('POST','/api/upload',true);
    if(adminPassword)xhr.setRequestHeader('X-Admin-Password',adminPassword);
    xhr.upload.onprogress=e=>{if(e.lengthComputable)onProgress(e.loaded,e.total);};
    xhr.onload=()=>{
      let d={};try{d=JSON.parse(xhr.responseText||'{}');}catch{}
      if(xhr.status>=200&&xhr.status<300)resolve(d);
      else reject(Object.assign(new Error(d.error||`请求失败 (${xhr.status})`),{status:xhr.status}));
    };
    xhr.onerror=()=>reject(new Error('网络错误，上传失败'));
    xhr.onabort=()=>reject(new Error('上传已取消'));
    xhr.send(fd);
  });
}
function eReset(){$('#fileInput').value='';$('#folderInput').value='';}
const drop=$('#dropZone');drop.ondragover=e=>{e.preventDefault();drop.classList.add('drag');drop.textContent='松开鼠标即可上传';};drop.ondragleave=()=>{drop.classList.remove('drag');drop.textContent='也可以把文件拖到这里上传';};drop.ondrop=e=>{e.preventDefault();drop.classList.remove('drag');drop.textContent='也可以把文件拖到这里上传';uploadFiles(e.dataTransfer.files);};

async function downloadPath(p){
  try{
    let url;
    if(guestMode){url=`/guest-download?path=${encodeURIComponent(p)}`;}
    else {const d=await api('/api/admin/download-ticket',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:p})});url=d.url;}
    const a=document.createElement('a');a.href=url+(guestMode?`&guestToken=${encodeURIComponent(guestToken)}`:'');a.download='';document.body.appendChild(a);a.click();a.remove();
  }catch(e){toast(e.message);}
}
async function showMove(p){
  let folders=[];
  try{const d=await api('/api/folders');folders=d.folders||[];}catch(e){toast(e.message);return;}
  const opts=folders.filter(x=>x!==p&&!x.startsWith(p+'/')).map(x=>`<option value="${esc(x)}">/${esc(x)}</option>`).join('');
  openModal('移动文件',`<div class="field"><label>当前路径</label><div class="muted" style="background:#f7f9fc;padding:10px;border-radius:9px;word-break:break-all">/${esc(p)}</div></div><div class="field"><label>移动到文件夹</label><select class="select" id="moveTarget"><option value="">/（根目录）</option>${opts}</select></div><div class="settings-note">如果目标位置已有同名文件/文件夹，系统会自动生成“(1)”“(2)”等名称。</div>`,`<button class="outline" onclick="closeModal()">取消</button><button class="primary" id="moveSave">移动</button>`);
  $('#moveSave').onclick=async()=>{try{await api('/api/move',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:p,destination:$('#moveTarget').value})});closeModal();toast('移动成功');loadFiles();}catch(e){toast(e.message);}};
}

function showNewFolder(){openModal('新建文件夹',`<div class="field"><label>文件夹名称</label><input class="input" id="newFolderName" autofocus placeholder="例如：照片"></div>`,`<button class="outline" onclick="closeModal()">取消</button><button class="primary" id="newFolderSave">创建文件夹</button>`);$('#newFolderSave').onclick=async()=>{const n=$('#newFolderName').value.trim();if(!n)return toast('请输入文件夹名称');try{await api('/api/folder',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:state.path,name:n})});closeModal();toast('文件夹已创建');loadFiles();}catch(e){toast(e.message);}};}
function showRename(p){const old=p.split('/').pop();openModal('重命名',`<div class="field"><label>新名称</label><input class="input" id="renameName" value="${esc(old)}" autofocus></div>`,`<button class="outline" onclick="closeModal()">取消</button><button class="primary" id="renameSave">保存</button>`);$('#renameSave').onclick=async()=>{const n=$('#renameName').value.trim();if(!n)return;try{await api('/api/rename',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:p,name:n})});closeModal();toast('已重命名');loadFiles();}catch(e){toast(e.message);}};}
async function removePath(p){if(!confirm(`确定删除“${p.split('/').pop()}”吗？\n文件夹删除后其中的内容也会一起删除。`))return;try{await api('/api/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:p})});toast('删除成功');loadFiles();}catch(e){toast(e.message);}}

function showShareCreate(p){openModal('创建分享',`<div class="field"><label>分享路径</label><div class="muted" style="background:#f7f9fc;padding:10px;border-radius:9px;word-break:break-all">${esc(p)}</div></div><div class="field"><label>分享密码 <span class="muted">（留空表示无密码）</span></label><input class="input" id="sharePassword" type="password" placeholder="可选"></div><div class="field-row"><div class="field"><label>有效期</label><select class="select" id="shareExpire"><option value="0">永久</option><option value="3600">1 小时</option><option value="86400">1 天</option><option value="604800">7 天</option><option value="2592000">30 天</option></select></div><div class="field"><label>最大下载次数</label><input class="input" id="shareMax" type="number" min="0" value="0"><div class="muted">0 表示不限</div></div></div>`,`<button class="outline" onclick="closeModal()">取消</button><button class="primary" id="createShareBtn">生成分享链接</button>`);$('#createShareBtn').onclick=async()=>{try{const d=await api('/api/shares',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:p,password:$('#sharePassword').value,expiresIn:+$('#shareExpire').value,maxDownloads:+$('#shareMax').value})});await copyText(d.url);closeModal();toast('分享链接已复制');setView('shares');}catch(e){toast(e.message);}};}

async function loadShares(){try{const d=await api('/api/shares?q='+encodeURIComponent(state.shareQuery));state.shares=d.shares;state.sharePage=1;renderShares();}catch(e){if(e.status===401){adminPassword='';sessionStorage.removeItem('fileshare_admin');if(await login())loadShares();}else toast(e.message);}}
function statusHtml(s){const c=s.status==='正常'?'ok':s.status==='已过期'?'expired':s.status==='次数用尽'?'used':'cancel';return `<span class="status ${c}">${esc(s.status)}</span>`;}
function renderShares(){const start=(state.sharePage-1)*state.pageSize;const rows=state.shares.slice(start,start+state.pageSize);$('#shareRows').innerHTML=rows.length?rows.map(s=>`<tr><td><input class="check share-check" type="checkbox" value="${esc(s.token)}"></td><td><span class="share-path">${esc(s.path.split('/').pop())}</span><span class="subpath">/${esc(s.path)}</span></td><td>${statusHtml(s)}</td><td>${s.hasPassword?'有 🔒':'无'}</td><td>${s.expiresAt?date(s.expiresAt):'永久'}</td><td><b>${s.downloads}</b> / ${s.maxDownloads||'∞'}</td><td>${date(s.createdAt)}</td><td><div class="row-actions"><button class="small-btn" data-share-act="copy" data-token="${esc(s.token)}">▣ 复制</button><button class="small-btn" data-share-act="edit" data-token="${esc(s.token)}">✎ 修改</button><button class="small-btn red" data-share-act="cancel" data-token="${esc(s.token)}">⌫ 取消</button></div></td></tr>`).join(''):`<tr><td colspan="8"><div class="empty">🔗<br><br>还没有分享链接</div></td></tr>`;const pages=Math.max(1,Math.ceil(state.shares.length/state.pageSize));let p='';for(let i=1;i<=pages;i++)if(pages>1)p+=`<button class="page-btn ${i===state.sharePage?'active':''}" data-share-page="${i}">${i}</button>`;$('#sharePager').innerHTML=state.shares.length?`共 ${state.shares.length} 个分享 ${p}`:'';$$('[data-share-page]').forEach(b=>b.onclick=()=>{state.sharePage=+b.dataset.sharePage;renderShares();});$('#selectAll').checked=false;}
$('#shareRows').onclick=async e=>{const b=e.target.closest('[data-share-act]');if(!b)return;const s=state.shares.find(x=>x.token===b.dataset.token);if(!s)return;if(b.dataset.shareAct==='copy'){await copyText(s.url);toast('链接已复制');}if(b.dataset.shareAct==='cancel'){if(confirm('确定取消这个分享吗？')){await api('/api/shares/'+encodeURIComponent(s.token),{method:'DELETE'});toast('分享已取消');loadShares();}}if(b.dataset.shareAct==='edit')showShareEdit(s);};
$('#shareSearch').oninput=e=>{clearTimeout(window.__search);window.__search=setTimeout(()=>{state.shareQuery=e.target.value;loadShares();},250);};$('#shareRefresh').onclick=loadShares;
$('#selectAll').onchange=e=>$$('.share-check').forEach(c=>c.checked=e.target.checked);
$('#batchCancelBtn').onclick=async()=>{const tokens=$$('.share-check:checked').map(x=>x.value);if(!tokens.length)return toast('请先选择分享');if(!confirm(`确定取消选中的 ${tokens.length} 个分享吗？`))return;await api('/api/shares/batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tokens})});toast('已批量取消');loadShares();};
function showShareEdit(s){openModal('修改分享',`<div class="field"><label>分享路径</label><div class="muted" style="background:#f7f9fc;padding:10px;border-radius:9px;word-break:break-all">${esc(s.path)}</div></div><div class="field-row"><div class="field"><label>有效期</label><select class="select" id="editExpire"><option value="0">永久</option><option value="3600">从现在起 1 小时</option><option value="86400">从现在起 1 天</option><option value="604800">从现在起 7 天</option><option value="2592000">从现在起 30 天</option></select></div><div class="field"><label>最大下载次数</label><input class="input" id="editMax" type="number" min="0" value="${s.maxDownloads}"></div></div><div class="field"><label>密码</label><div class="radio-row"><label><input type="radio" name="pm" value="keep" checked> 保持当前</label><label><input type="radio" name="pm" value="set"> 设置新密码</label><label><input type="radio" name="pm" value="remove"> 移除密码</label></div><input class="input" id="editPass" type="password" placeholder="选择设置新密码时填写"></div>`,`<button class="outline" onclick="closeModal()">取消</button><button class="primary" id="editSave">保存修改</button>`);$('#editSave').onclick=async()=>{const mode=$('input[name="pm"]:checked').value;try{await api('/api/shares/'+encodeURIComponent(s.token),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({expiresIn:+$('#editExpire').value,maxDownloads:+$('#editMax').value,passwordMode:mode,password:$('#editPass').value})});closeModal();toast('分享设置已更新');loadShares();}catch(e){toast(e.message);}};}

async function showSettings(initialTab='storage'){
  if(!(await ensureAdmin())) return;
  let storage, guests=[];
  try { storage=await api('/api/admin/storage'); const g=await api('/api/admin/guests'); guests=g.accounts||[]; } catch(e){ toast(e.message); return; }
  openModal('管理设置',`<div class="settings-tabs"><button class="settings-tab active" data-tab="storage">存储空间</button><button class="settings-tab" data-tab="guests">来宾账号</button><button class="settings-tab" data-tab="password">管理员密码</button></div>
  <div id="settingsStoragePanel"><div class="field"><label>单个文件最大上传大小</label><div class="input-suffix"><input class="input" id="maxFileSizeMB" type="number" min="1" max="1048576" value="${esc(storage.maxFileSizeMB)}"><span>MB</span></div></div><div class="field"><label>整个存储空间大小</label><div class="input-suffix"><input class="input" id="maxStorageGB" type="number" min="0" max="1048576" value="${esc(storage.maxStorageGB)}"><span>GB</span></div></div><div class="settings-note">设置为 0 表示不限空间。</div></div>
  <div id="settingsGuestsPanel" style="display:none"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><b>来宾账号</b><button class="primary" id="addGuestBtn">＋ 新建来宾账号</button></div><div class="table-wrap"><table class="table" style="min-width:520px"><thead><tr><th>账号</th><th>状态</th><th>最后登录</th><th style="text-align:right">操作</th></tr></thead><tbody id="guestRows">${guests.length?guests.map(g=>`<tr><td><b>${esc(g.username)}</b></td><td><span class="status ${g.enabled?'ok':'cancel'}">${g.enabled?'启用':'停用'}</span></td><td>${g.lastLoginAt?date(g.lastLoginAt):'从未登录'}</td><td style="text-align:right"><button class="small-btn" data-guest-act="toggle" data-id="${esc(g.id)}">${g.enabled?'停用':'启用'}</button><button class="small-btn" data-guest-act="password" data-id="${esc(g.id)}">改密码</button><button class="small-btn red" data-guest-act="delete" data-id="${esc(g.id)}">删除</button></td></tr>`).join(''):`<tr><td colspan="4"><div class="empty">还没有来宾账号</div></td></tr>`}</tbody></table></div><div class="settings-note">来宾账号只能浏览和下载 /files 中的内容，不能上传、删除、重命名、移动或创建分享。</div></div>
  <div id="settingsPasswordPanel" style="display:none"><div class="field"><label>当前管理员密码</label><input class="input" id="oldPassword" type="password"></div><div class="field"><label>新管理员密码</label><input class="input" id="newPassword" type="password" placeholder="至少 8 位"></div></div>`, `<button class="outline" onclick="closeModal()">关闭</button><button class="primary" id="settingsSave">保存设置</button>`);
  const tabs=$$('.settings-tab'); tabs.forEach(tab=>tab.onclick=()=>{tabs.forEach(x=>x.classList.toggle('active',x===tab));const mode=tab.dataset.tab;$('#settingsStoragePanel').style.display=mode==='storage'?'block':'none';$('#settingsGuestsPanel').style.display=mode==='guests'?'block':'none';$('#settingsPasswordPanel').style.display=mode==='password'?'block':'none';$('#settingsSave').style.display=mode==='guests'?'none':'';}); const initial=$(`.settings-tab[data-tab="${initialTab}"]`); if(initial) initial.click();
  $('#settingsSave').onclick=async()=>{const mode=document.querySelector('.settings-tab.active')?.dataset.tab;try{if(mode==='storage'){await api('/api/admin/storage',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({maxFileSizeMB:Number($('#maxFileSizeMB').value),maxStorageGB:Number($('#maxStorageGB').value)})});closeModal();toast('存储空间设置已保存');loadStorage();}else{const old=$('#oldPassword').value,n=$('#newPassword').value;await api('/api/admin/password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({current:old,newPassword:n})});adminPassword=n;sessionStorage.setItem('fileshare_admin',n);closeModal();toast('管理员密码已修改');}}catch(e){toast(e.message);}};
  $('#addGuestBtn').onclick=()=>showGuestCreate();
  $('#guestRows').onclick=async e=>{const b=e.target.closest('[data-guest-act]');if(!b)return;const id=b.dataset.id;const g=guests.find(x=>x.id===id);try{if(b.dataset.guestAct==='toggle')await api('/api/admin/guests/'+encodeURIComponent(id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:!g.enabled})});if(b.dataset.guestAct==='password'){const n=prompt('请输入新的来宾密码（至少6位）');if(n===null)return;await api('/api/admin/guests/'+encodeURIComponent(id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:n})});}if(b.dataset.guestAct==='delete'){if(!confirm('确定删除该来宾账号？'))return;await api('/api/admin/guests/'+encodeURIComponent(id),{method:'DELETE'});}toast('操作成功');showSettings();}catch(e){toast(e.message);}};
}
function showGuestCreate(){openModal('新建来宾账号',`<div class="field"><label>账号</label><input class="input" id="newGuestUser" placeholder="例如 guest01"></div><div class="field"><label>密码</label><input class="input" id="newGuestPass" type="password" placeholder="至少 6 位"></div><div class="settings-note">来宾账号创建后只能浏览和下载文件。</div>`,`<button class="outline" onclick="closeModal()">取消</button><button class="primary" id="guestCreateSave">创建</button>`);$('#guestCreateSave').onclick=async()=>{try{await api('/api/admin/guests',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:$('#newGuestUser').value.trim(),password:$('#newGuestPass').value})});closeModal();toast('来宾账号已创建');showSettings();}catch(e){toast(e.message);}};}

(async()=>{try{if(guestMode){if(await ensureGuest())loadGuestFiles();}else if(await ensureAdmin())await loadFiles();}catch(e){toast(e.message);}})();
