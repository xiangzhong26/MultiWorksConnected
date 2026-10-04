let historyWindow=false,historyCursor=0,stagedFiles=[],stagedRoom=null,roomToDelete=null,locatedId=null;
let libraryRows=[],globalRows=[],libraryGeneration=0,globalGeneration=0,libraryTimer,globalTimer,fileSearchTimer;
const activeTransfers=new Set();

function setNoRoom(){
  active=null;messages=[];hasMore=false;historyWindow=false;roomGeneration++;
  $('messages').replaceChildren();$('room-title').textContent='新建一个项目群';$('text').value='';$('search').value='';
  $('empty').hidden=false;$('empty').querySelector('h2').textContent='为你的工作创建一个项目群';
  $('empty').querySelector('p').textContent='点击左侧项目群旁的 ＋ 开始。';
  $('composer').hidden=true;$('search').disabled=true;$('rename-room').disabled=true;$('delete-room').disabled=true;
  $('load-older').hidden=true;setHistoryControls();renderRooms();
}
function setHistoryControls(){$('load-newer').hidden=!historyWindow;$('back-latest').hidden=!historyWindow;}
function resetFileSession(){
  for(const item of activeTransfers){item.cancelled=true;item.xhr?.abort();item.row.remove();}
  activeTransfers.clear();libraryGeneration++;globalGeneration++;libraryRows=[];globalRows=[];
  $('file-library').replaceChildren();$('global-results').replaceChildren();$('file-count').textContent='';
  if($('upload-dialog').open)$('upload-dialog').close();
}
function previewLink(message){return `/preview.html?id=${message.id}`;}
function createFileCard(message){
  const wrapper=document.createElement('div');wrapper.className='file-attachment';
  const link=document.createElement('a');link.className='file-card';link.href=previewLink(message);link.target='_blank';link.rel='noopener';link.draggable=true;
  link.title='点击预览；支持的桌面浏览器可拖到文件夹保存';
  const icon=document.createElement('span');icon.className='file-icon';icon.textContent=(message.file_name.split('.').pop()||'FILE').slice(0,5).toUpperCase();
  const info=document.createElement('span');info.className='file-detail';
  const title=document.createElement('strong');title.textContent=message.file_name;
  const detail=document.createElement('small');detail.textContent=size(message.file_size)+' · 点击预览';
  info.append(title,detail);link.append(icon,info);
  link.ondragstart=e=>{
    const url=new URL(`/api/files/${message.id}`,location.origin).href;
    const filename=message.file_name.replace(/[\\/:\r\n]/g,'_');
    e.dataTransfer.effectAllowed='copy';e.dataTransfer.setData('DownloadURL',`application/octet-stream:${filename}:${url}`);
    e.dataTransfer.setData('text/uri-list',url);e.dataTransfer.setData('application/x-multiworks-file',String(message.id));
  };
  const actions=document.createElement('div');actions.className='file-actions';
  const download=document.createElement('a');download.href=`/api/files/${message.id}`;download.download=message.file_name;download.textContent='下载';
  const open=document.createElement('a');open.href=previewLink(message);open.target='_blank';open.rel='noopener';open.textContent='预览';
  actions.append(open,download);wrapper.append(link,actions);return wrapper;
}

function stageFiles(files){
  if(!user||!active){toast('请先选择一个项目群');return;}
  const valid=[...files].filter(file=>{if(file.size>window.maxFileMB*1048576){toast(`${file.name} 超过 ${window.maxFileMB} MB`);return false;}return true;});
  if(!valid.length)return;
  if(!$('upload-dialog').open){stagedFiles=[];stagedRoom=active;}
  stagedFiles.push(...valid);renderStaged();if(!$('upload-dialog').open)$('upload-dialog').showModal();
}
function renderStaged(){
  $('upload-target').textContent=`发送到「${rooms.find(r=>r.id===stagedRoom)?.name||'已删除的群'}」 · ${stagedFiles.length} 个文件。确认前不会上传。`;
  $('selected-files').replaceChildren();
  stagedFiles.forEach((file,index)=>{
    const row=document.createElement('div');row.className='selected-file';const label=document.createElement('span');label.textContent=`${file.name} · ${size(file.size)}`;
    const remove=document.createElement('button');remove.className='secondary';remove.textContent='移除';remove.onclick=()=>{stagedFiles.splice(index,1);renderStaged();};
    row.append(label,remove);$('selected-files').append(row);
  });$('confirm-upload').disabled=!stagedFiles.length;
}
$('cancel-upload').onclick=()=>$('upload-dialog').close();
$('upload-dialog').addEventListener('close',()=>{stagedFiles=[];stagedRoom=null;});
$('confirm-upload').onclick=()=>{
  if(!rooms.some(r=>r.id===stagedRoom)){toast('项目群已被删除');$('upload-dialog').close();return;}
  const files=[...stagedFiles],roomId=stagedRoom;$('upload-dialog').close();queueFiles(files,roomId);
};
let incomingDragDepth=0;
const isIncomingFile=e=>[...(e.dataTransfer?.types||[])].includes('Files')&&!e.dataTransfer.types.includes('application/x-multiworks-file');
document.addEventListener('dragenter',e=>{if(isIncomingFile(e)){e.preventDefault();incomingDragDepth++;if(user)$('workspace').classList.add('file-dragging');}});
document.addEventListener('dragover',e=>{if(isIncomingFile(e)){e.preventDefault();e.dataTransfer.dropEffect=user&&active?'copy':'none';}});
document.addEventListener('dragleave',e=>{if(isIncomingFile(e)&&--incomingDragDepth<=0)$('workspace').classList.remove('file-dragging');});
document.addEventListener('drop',e=>{
  const incoming=isIncomingFile(e),internal=e.dataTransfer?.types.includes('application/x-multiworks-file');
  if(incoming||internal)e.preventDefault();incomingDragDepth=0;$('workspace').classList.remove('file-dragging');
  if(incoming)stageFiles(e.dataTransfer.files);
});
document.addEventListener('dragend',()=>{incomingDragDepth=0;$('workspace').classList.remove('file-dragging');});

$('delete-room').onclick=()=>{
  if(!active)return;roomToDelete=active;
  $('delete-room-warning').textContent=`将永久删除「${rooms.find(r=>r.id===active)?.name}」及其中所有消息和文件，所有设备同步移除。此操作无法撤销。`;
  $('delete-room-dialog').showModal();
};
$('cancel-delete-room').onclick=()=>$('delete-room-dialog').close();
$('confirm-delete-room').onclick=async()=>{
  $('confirm-delete-room').disabled=true;
  try{await api(`/rooms/${roomToDelete}`,{method:'DELETE'});handleDeletedRoom(roomToDelete);$('delete-room-dialog').close();await refreshRooms();scheduleLibraryRefresh();toast('项目群已删除');}
  catch(e){toast(e.message);}finally{$('confirm-delete-room').disabled=false;}
};
function handleDeletedRoom(id){
  delete drafts[id];sessionStorage.setItem('mw-drafts',JSON.stringify(drafts));
  for(const [key,message] of pending)if(message.room_id===id)pending.delete(key);
  for(const item of activeTransfers)if(item.roomId===id){item.cancelled=true;item.xhr?.abort();item.row.remove();activeTransfers.delete(item);}
  if(stagedRoom===id&&$('upload-dialog').open)$('upload-dialog').close();
}
async function locateMessage(message){
  try{if(!rooms.some(r=>r.id===message.room_id))await refreshRooms();await selectRoom(message.room_id,message.id);}
  catch(e){toast(e.message);}
}
$('back-latest').onclick=()=>selectRoom(active).catch(e=>toast(e.message));
$('load-newer').onclick=async()=>{
  const id=active,generation=roomGeneration;
  try{
    const rows=await api(`/rooms/${id}/messages?after=${historyCursor}`);if(generation!==roomGeneration)return;
    for(const row of rows)if(!messages.some(m=>m.id===row.id))messages.push(row);
    messages.sort((a,b)=>a.id-b.id);historyCursor=rows.at(-1)?.id||historyCursor;historyWindow=rows.length===100;
    renderMessages();setHistoryControls();
  }catch(e){toast(e.message);}
};
function scheduleLibraryRefresh(){clearTimeout(libraryTimer);libraryTimer=setTimeout(()=>{if(user){loadLibrary().catch(e=>toast(e.message));if($('global-search').value.trim())loadGlobal().catch(e=>toast(e.message));}},150);}
async function loadLibrary(more=false){
  const generation=++libraryGeneration;const query=$('file-search').value.trim();
  const rows=await api(`/files?q=${encodeURIComponent(query)}${more&&libraryRows.length?`&before=${libraryRows.at(-1).id}`:''}`);
  if(generation!==libraryGeneration)return;libraryRows=more?[...libraryRows,...rows]:rows;$('more-files').hidden=rows.length<100;renderLibrary();
}
function renderLibrary(){
  $('file-library').replaceChildren();$('file-count').textContent=libraryRows.length?`(${libraryRows.length}${!$('more-files').hidden?'+':''})`:'';
  if(!libraryRows.length){const empty=document.createElement('p');empty.className='sidebar-empty';empty.textContent='没有匹配的文件';$('file-library').append(empty);}
  for(const message of libraryRows){
    const row=document.createElement('div');row.className='library-item';
    const link=document.createElement('a');link.href=previewLink(message);link.target='_blank';link.rel='noopener';link.textContent=message.file_name;
    const meta=document.createElement('small');meta.textContent=`${message.room_name} · ${size(message.file_size)}`;
    const locate=document.createElement('button');locate.className='locate-button';locate.textContent='定位消息';locate.onclick=()=>locateMessage(message);
    row.append(link,meta,locate);$('file-library').append(row);
  }
}
async function loadGlobal(more=false){
  const generation=++globalGeneration,query=$('global-search').value.trim();
  if(!query){globalRows=[];renderGlobal();$('more-results').hidden=true;return;}
  const rows=await api(`/search?q=${encodeURIComponent(query)}${more&&globalRows.length?`&before=${globalRows.at(-1).id}`:''}`);
  if(generation!==globalGeneration)return;globalRows=more?[...globalRows,...rows]:rows;renderGlobal();$('more-results').hidden=rows.length<100;
}
function renderGlobal(){
  $('global-results').replaceChildren();
  if(!globalRows.length){const empty=document.createElement('p');empty.className='sidebar-empty';empty.textContent=$('global-search').value.trim()?'没有匹配的消息':'输入关键词搜索所有项目';$('global-results').append(empty);}
  for(const message of globalRows){
    const button=document.createElement('button');button.className='global-result';const title=document.createElement('strong');title.textContent=message.room_name;
    const excerpt=document.createElement('span');excerpt.textContent=(message.file_name||message.body).slice(0,160);
    const date=document.createElement('small');date.textContent=new Date(message.created).toLocaleString('zh-CN');button.append(title,excerpt,date);button.onclick=()=>locateMessage(message);$('global-results').append(button);
  }
}
$('file-search').oninput=()=>{libraryGeneration++;clearTimeout(fileSearchTimer);fileSearchTimer=setTimeout(()=>loadLibrary().catch(e=>toast(e.message)),250);};
$('global-search').oninput=()=>{globalGeneration++;clearTimeout(globalTimer);globalTimer=setTimeout(()=>loadGlobal().catch(e=>toast(e.message)),250);};
$('more-files').onclick=()=>loadLibrary(true).catch(e=>toast(e.message));$('more-results').onclick=()=>loadGlobal(true).catch(e=>toast(e.message));
$('file-section').ontoggle=()=>{if($('file-section').open&&user)loadLibrary().catch(e=>toast(e.message));};
renderGlobal();
