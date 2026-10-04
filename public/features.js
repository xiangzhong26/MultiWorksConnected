function tr(text){return typeof t==='function'?t(text):text;}
let historyWindow=false,historyCursor=0,stagedFiles=[],stagedRoom=null,roomToDelete=null,locatedId=null;
let globalRows=[],globalGeneration=0,libraryTimer,globalTimer;
const activeTransfers=new Set();
const inlineImageViews=new Map(),expandedInlineImages=new Set(),collapsedInlineImages=new Set(),stagedImageUrls=new Set();
const inlineImageExtension=/\.(png|jpe?g|gif|webp)$/i;
function releaseStagedImages(){for(const url of stagedImageUrls)URL.revokeObjectURL(url);stagedImageUrls.clear();}
function pruneInlineImages(visible){
  const ids=new Set(visible.filter(m=>m.file_key&&inlineImageExtension.test(m.file_name)).map(m=>m.id));
  for(const [id,entry] of inlineImageViews)if(!ids.has(id)){entry.image?.removeAttribute('src');inlineImageViews.delete(id);expandedInlineImages.delete(id);collapsedInlineImages.delete(id);}
}
function inlineImageView(message){
  let entry=inlineImageViews.get(message.id);
  if(!entry){const view=document.createElement('div');view.className='inline-image-view';view.id=`inline-image-${message.id}`;entry={view,image:null};inlineImageViews.set(message.id,entry);}
  return entry;
}
function attachmentDrag(event,message){
  const url=new URL(`/api/files/${message.id}`,location.origin).href;
  const filename=message.file_name.replace(/[\\/:\r\n]/g,'_');
  event.dataTransfer.effectAllowed='copy';event.dataTransfer.setData('DownloadURL',`application/octet-stream:${filename}:${url}`);
  event.dataTransfer.setData('text/uri-list',url);event.dataTransfer.setData('application/x-multiworks-file',String(message.id));
}
function showInlineImage(entry,message){
  entry.view.hidden=false;
  if(entry.image)return;
  const link=document.createElement('a');link.href=previewLink(message);link.target='_blank';link.rel='noopener';link.className='inline-image-link';link.draggable=true;link.ondragstart=e=>attachmentDrag(e,message);
  const image=document.createElement('img');image.className='inline-image';image.alt=message.file_name;image.loading='lazy';image.decoding='async';image.width=360;image.height=200;
  image.onerror=()=>{image.removeAttribute('src');entry.image=null;entry.view.replaceChildren();const note=document.createElement('p');note.className='inline-image-error';note.textContent=tr('图片暂时无法显示，可点击小眼睛重试或下载原文件。');entry.view.append(note);};
  image.src=`/api/files/${message.id}/content`;entry.image=image;link.append(image);entry.view.replaceChildren(link);
}

function setNoRoom(){
  active=null;messages=[];hasMore=false;historyWindow=false;roomGeneration++;
  $('messages').replaceChildren();$('room-title').textContent=tr('新建一个项目群');$('text').value='';$('search').value='';
  $('empty').hidden=false;$('empty').querySelector('h2').textContent=tr('为你的工作创建一个项目群');
  $('empty').querySelector('p').textContent=tr('点击左侧项目群旁的 ＋ 开始。');
  $('composer').hidden=true;$('search').disabled=true;$('rename-room').disabled=true;$('delete-room').disabled=true;
  $('load-older').hidden=true;setHistoryControls();renderRooms();
}
function setHistoryControls(){$('load-newer').hidden=!historyWindow;$('back-latest').hidden=!historyWindow;}
function resetFileSession(){
  releaseStagedImages();pruneInlineImages([]);expandedInlineImages.clear();collapsedInlineImages.clear();
  for(const item of activeTransfers){item.cancelled=true;item.xhr?.abort();item.row.remove();}
  activeTransfers.clear();globalGeneration++;globalRows=[];
  $('global-results').replaceChildren();
  if($('upload-dialog').open)$('upload-dialog').close();
}
function previewLink(message){return `/preview.html?id=${message.id}`;}
function createFileCard(message){
  const wrapper=document.createElement('div');wrapper.className='file-attachment';
  const link=document.createElement('a');link.className='file-card';link.href=previewLink(message);link.target='_blank';link.rel='noopener';link.draggable=true;
  link.title=tr('点击预览；支持的桌面浏览器可拖到文件夹保存');
  const icon=document.createElement('span');icon.className='file-icon';icon.textContent=(message.file_name.split('.').pop()||'FILE').slice(0,5).toUpperCase();
  const info=document.createElement('span');info.className='file-detail';
  const title=document.createElement('strong');title.textContent=message.file_name;
  const detail=document.createElement('small');detail.textContent=size(message.file_size)+(typeof language!=='undefined'&&language==='en'?' · Click to preview':' · 点击预览');
  info.append(title,detail);link.append(icon,info);
  link.ondragstart=e=>attachmentDrag(e,message);
  const actions=document.createElement('div');actions.className='file-actions';
  const download=document.createElement('a');download.href=`/api/files/${message.id}`;download.download=message.file_name;download.textContent=tr('下载');
  const open=document.createElement('a');open.href=previewLink(message);open.target='_blank';open.rel='noopener';open.textContent=tr('预览');
  actions.append(open,download);wrapper.append(link);
  if(inlineImageExtension.test(message.file_name)){
    const recent=Number.isFinite(message.created)&&message.created>Date.now()-7*86400000;
    const entry=inlineImageView(message),eye=document.createElement('button');eye.type='button';eye.className='image-eye';eye.textContent='👁';eye.setAttribute('aria-controls',entry.view.id);
    let visible=recent?!collapsedInlineImages.has(message.id):expandedInlineImages.has(message.id);
    function update(){
      entry.view.hidden=!visible;if(visible)showInlineImage(entry,message);
      eye.title=tr(visible?'收起图片':'显示图片');eye.setAttribute('aria-label',eye.title);eye.setAttribute('aria-expanded',String(visible));
    }
    eye.onclick=()=>{if(visible&&!entry.image){update();return;}visible=!visible;if(recent){if(visible)collapsedInlineImages.delete(message.id);else collapsedInlineImages.add(message.id);}else{if(visible)expandedInlineImages.add(message.id);else expandedInlineImages.delete(message.id);}update();};
    if(!recent)detail.textContent=size(message.file_size)+' · '+tr('7 天前的图片，点击小眼睛展开');
    update();wrapper.append(entry.view);actions.prepend(eye);
  }
  wrapper.append(actions);return wrapper;
}

// Clipboard events do not require clipboard-read permission and work on local HTTP too.
function pasteAttachments(event){
  const clipboard=event.clipboardData;if(!clipboard)return;
  let files=[...(clipboard.items||[])].filter(item=>item.kind==='file').map(item=>item.getAsFile()).filter(Boolean);
  if(!files.length)files=[...(clipboard.files||[])];
  if(!files.length)return; // Leave ordinary text, links and rich-text-to-text pastes to the textarea.
  event.preventDefault();
  const now=new Date(),pad=(n,width=2)=>String(n).padStart(width,'0');
  const stamp=`${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${pad(now.getMilliseconds(),3)}`;
  const extensions={'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp','image/bmp':'bmp','image/avif':'avif'};
  files=files.map((file,index)=>{
    if(!file.type?.startsWith('image/'))return file;
    const ext=extensions[file.type];if(!ext)return file;
    if(file.name&& !/^(image|blob|clipboard)(\.[a-z0-9]+)?$/i.test(file.name)&&inlineImageExtension.test(file.name))return file;
    return new File([file],`clipboard-${stamp}-${index+1}.${ext}`,{type:file.type,lastModified:file.lastModified||Date.now()});
  });
  const text=clipboard.getData?.('text/plain');
  if(text&&event.target===$('text')){$('text').setRangeText(text,$('text').selectionStart,$('text').selectionEnd,'end');$('text').oninput?.();}
  stageFiles(files);
}
$('text').addEventListener('paste',pasteAttachments);
$('upload-dialog').addEventListener('paste',pasteAttachments);

function stageFiles(files){
  if(!user||!active){toast('请先选择一个项目群');return;}
  if([...files].some(file=>file.webkitRelativePath?.includes('/'))){toast('不支持上传文件夹，请先压缩成 ZIP 等压缩包后上传。');return;}
  const valid=[...files].filter(file=>{if(file.size>window.maxFileMB*1048576){toast(typeof language!=='undefined'&&language==='en'?`${file.name} exceeds ${window.maxFileMB} MB`:`${file.name} 超过 ${window.maxFileMB} MB`);return false;}return true;});
  if(!valid.length)return;
  if(!$('upload-dialog').open){stagedFiles=[];stagedRoom=active;}
  stagedFiles.push(...valid);renderStaged();if(!$('upload-dialog').open)$('upload-dialog').showModal();
}
function renderStaged(){
  releaseStagedImages();
  $('upload-target').textContent=typeof language!=='undefined'&&language==='en'?`Send to ${rooms.find(r=>r.id===stagedRoom)?.name||'Deleted project'} · ${stagedFiles.length} files. No upload before confirmation.`:`发送到「${rooms.find(r=>r.id===stagedRoom)?.name||'已删除的群'}」 · ${stagedFiles.length} 个文件。确认前不会上传。`;
  $('selected-files').replaceChildren();
  stagedFiles.forEach((file,index)=>{
    const row=document.createElement('div');row.className='selected-file';const label=document.createElement('span');label.textContent=`${file.name} · ${size(file.size)}`;
    const remove=document.createElement('button');remove.className='secondary';remove.textContent=tr('移除');remove.onclick=()=>{stagedFiles.splice(index,1);renderStaged();};
    if(/^image\/(png|jpeg|gif|webp)$/.test(file.type||'')){
      const image=document.createElement('img');image.className='staged-image';image.alt=file.name;
      const url=URL.createObjectURL(file);stagedImageUrls.add(url);image.src=url;row.append(image);
    }
    row.append(label,remove);$('selected-files').append(row);
  });$('confirm-upload').disabled=!stagedFiles.length;
}
$('cancel-upload').onclick=()=>$('upload-dialog').close();
$('upload-dialog').addEventListener('close',()=>{releaseStagedImages();$('selected-files').replaceChildren();stagedFiles=[];stagedRoom=null;});
$('confirm-upload').onclick=()=>{
  if(!rooms.some(r=>r.id===stagedRoom)){toast('项目群已被删除');$('upload-dialog').close();return;}
  const files=[...stagedFiles],roomId=stagedRoom;$('upload-dialog').close();queueFiles(files,roomId);
};
let incomingDragDepth=0;
async function stageDroppedFiles(dataTransfer){
  const roomId=active;
  // Capture entries and handles during the drop event; browsers protect them afterwards.
  const files=[...dataTransfer.files];
  const items=[...(dataTransfer.items||[])].filter(item=>item.kind==='file');
  const entries=items.map(item=>{try{return item.webkitGetAsEntry?.();}catch{return null;}});
  if(entries.some(entry=>entry?.isDirectory)){toast('不支持上传文件夹，请先压缩成 ZIP 等压缩包后上传。');return;}
  const handles=items.map((item,index)=>{try{return !entries[index]&&item.getAsFileSystemHandle?item.getAsFileSystemHandle():null;}catch{return null;}});
  if(handles.some(Boolean)){
    const results=await Promise.allSettled(handles);
    if(results.some(result=>result.status==='fulfilled'&&result.value?.kind==='directory')){toast('不支持上传文件夹，请先压缩成 ZIP 等压缩包后上传。');return;}
  }
  try{await Promise.all(files.map(file=>typeof file.slice==='function'?file.slice(0,1).arrayBuffer():Promise.resolve()));}
  catch{toast('无法读取拖入的内容；不支持上传文件夹，请压缩后上传。');return;}
  if(active!==roomId){toast('当前项目已切换，请重新选择要上传的文件。');return;}
  if(files.length)stageFiles(files);else toast('不支持上传文件夹，请先压缩成 ZIP 等压缩包后上传。');
}
const isIncomingFile=e=>[...(e.dataTransfer?.types||[])].includes('Files')&&!e.dataTransfer.types.includes('application/x-multiworks-file');
document.addEventListener('dragenter',e=>{if(isIncomingFile(e)){e.preventDefault();incomingDragDepth++;if(user)$('workspace').classList.add('file-dragging');}});
document.addEventListener('dragover',e=>{if(isIncomingFile(e)){e.preventDefault();e.dataTransfer.dropEffect=user&&active?'copy':'none';}});
document.addEventListener('dragleave',e=>{if(isIncomingFile(e)&&--incomingDragDepth<=0)$('workspace').classList.remove('file-dragging');});
document.addEventListener('drop',e=>{
  const incoming=isIncomingFile(e),internal=e.dataTransfer?.types.includes('application/x-multiworks-file');
  if(incoming||internal)e.preventDefault();incomingDragDepth=0;$('workspace').classList.remove('file-dragging');
  if(incoming)return stageDroppedFiles(e.dataTransfer);
});
document.addEventListener('dragend',()=>{incomingDragDepth=0;$('workspace').classList.remove('file-dragging');});

$('delete-room').onclick=()=>{
  if(!active)return;roomToDelete=active;
  $('delete-room-warning').textContent=typeof language!=='undefined'&&language==='en'?`Permanently delete ${rooms.find(r=>r.id===active)?.name}, all messages and physical attachments? This cannot be undone.`:`将永久删除「${rooms.find(r=>r.id===active)?.name}」及其中所有消息和文件，所有设备同步移除。此操作无法撤销。`;
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
    messages.sort((a,b)=>a.id-b.id);if(messages.length>300){messages=messages.slice(-300);hasMore=true;}historyCursor=rows.at(-1)?.id||historyCursor;historyWindow=rows.length===100;
    renderMessages();setHistoryControls();
  }catch(e){toast(e.message);}
};
function scheduleLibraryRefresh(){clearTimeout(libraryTimer);libraryTimer=setTimeout(()=>{if(user){if($('global-search').value.trim())loadGlobal().catch(e=>toast(e.message));}},150);}
async function loadGlobal(more=false){
  const generation=++globalGeneration,query=$('global-search').value.trim();
  if(!query){globalRows=[];renderGlobal();$('more-results').hidden=true;return;}
  const rows=await api(`/search?q=${encodeURIComponent(query)}${more&&globalRows.length?`&before=${globalRows.at(-1).id}`:''}`);
  if(generation!==globalGeneration)return;globalRows=more?[...globalRows,...rows]:rows;renderGlobal();$('more-results').hidden=rows.length<100;
}
function renderGlobal(){
  $('global-results').replaceChildren();
  if(!globalRows.length){const empty=document.createElement('p');empty.className='sidebar-empty';empty.textContent=tr($('global-search').value.trim()?'没有匹配的消息':'输入关键词搜索所有项目');$('global-results').append(empty);}
  for(const message of globalRows){
    const button=document.createElement('button');button.className='global-result';const title=document.createElement('strong');title.textContent=message.room_name;
    const excerpt=document.createElement('span');excerpt.textContent=(message.file_name||message.body).slice(0,160);
    const date=document.createElement('small');date.textContent=new Date(message.created).toLocaleString(typeof language!=='undefined'&&language==='en'?'en-US':'zh-CN');button.append(title,excerpt,date);button.onclick=()=>locateMessage(message);$('global-results').append(button);
  }
}
$('global-search').oninput=()=>{globalGeneration++;clearTimeout(globalTimer);globalTimer=setTimeout(()=>loadGlobal().catch(e=>toast(e.message)),250);};
$('more-results').onclick=()=>loadGlobal(true).catch(e=>toast(e.message));
renderGlobal();
