let groups=[],draggedRoom=null,editingGuest=null;
const collapsedGroups=JSON.parse(localStorage.getItem('mw-collapsed-groups')||'{}');
function el(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=t(text);if(className)node.className=className;return node;}
function dateLabel(value){return value?new Date(value).toLocaleString(language==='en'?'en-US':'zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):t('暂无消息');}
async function loadGroups(){groups=user&&!user.guest?await api('/groups'):[];}
async function moveProject(source,targetId,after=false){
  if(source===targetId)return;const destination=rooms.find(r=>r.id===targetId),moving=rooms.find(r=>r.id===source);if(!destination||!moving)return;
  const ordered=rooms.filter(r=>r.id!==source);ordered.splice(ordered.findIndex(r=>r.id===targetId)+(after?1:0),0,moving);
  try{await api(`/rooms/${source}`,{method:'PATCH',body:JSON.stringify({groupId:destination.group_id||null})});await api('/rooms/order',{method:'POST',body:JSON.stringify({ids:ordered.map(r=>r.id)})});await refreshRooms();}catch(e){toast(e.message);}
}
function projectGrip(room){
  const grip=el('button','⠿','room-grip');grip.title=t('拖动调整顺序');grip.setAttribute('aria-label',t('拖动调整顺序')+': '+room.name);let start,target,moved=false;
  const clear=()=>{document.querySelectorAll('.drag-over').forEach(n=>n.classList.remove('drag-over'));start=null;target=null;moved=false;};
  grip.onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();start={x:e.clientX,y:e.clientY};target=null;moved=false;grip.setPointerCapture(e.pointerId);};
  grip.onpointermove=e=>{if(!start)return;if(Math.hypot(e.clientX-start.x,e.clientY-start.y)<6)return;moved=true;document.querySelectorAll('.drag-over').forEach(n=>n.classList.remove('drag-over'));const row=document.elementFromPoint(e.clientX,e.clientY)?.closest('.room-row');target=row?.dataset.roomId||null;if(target&&target!==room.id)row.classList.add('drag-over');};
  grip.onpointerup=e=>{if(!start)return;const destination=target,shouldMove=moved&&destination&&destination!==room.id;clear();if(shouldMove){e.preventDefault();moveProject(room.id,destination);}};
  grip.onpointercancel=clear;grip.onkeydown=e=>{if(!['ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();const subset=rooms.filter(r=>(r.group_id||null)===(room.group_id||null)),index=subset.findIndex(r=>r.id===room.id),next=subset[index+(e.key==='ArrowUp'?-1:1)];if(next)moveProject(room.id,next.id,e.key==='ArrowDown');};return grip;
}
function renderProjectList(){
  const nav=$('rooms');nav.replaceChildren();
  const sections=[{id:null,name:t('未分组')},...groups];
  // Guests see only granted rooms, grouped by the server's visible group names.
  if(user?.guest)for(const room of rooms)if(room.group_id&&!sections.some(g=>g.id===room.group_id))sections.push({id:room.group_id,name:room.group_name||t('项目群')});
  for(const group of sections){
    const subset=rooms.filter(r=>(r.group_id||null)===group.id);if(!subset.length&&group.id===null)continue;
    let parent=nav;
    if(group.id){const details=el('details',undefined,'room-group');details.open=collapsedGroups[group.id]===false;const summary=el('summary',`${group.name} (${subset.length})`);details.append(summary);details.ontoggle=()=>{collapsedGroups[group.id]=!details.open;localStorage.setItem('mw-collapsed-groups',JSON.stringify(collapsedGroups));};nav.append(details);parent=details;}
    for(const room of subset){
      const row=el('div',undefined,'room-row');row.dataset.roomId=room.id;row.draggable=!user?.guest;
      const button=el('button',undefined,'room'+(room.id===active?' active':''));button.draggable=!user?.guest;const mark=el('span','#','room-mark'),copy=el('span',undefined,'room-copy');
      const title=el('strong');title.textContent=room.name;const preview=el('small');preview.textContent=room.file_preview?`📎 ${room.file_preview}`:room.preview||t('暂无消息');copy.append(title,preview);
      const times=el('small',`${t('创建')} ${dateLabel(room.created)} · ${t('最近消息')} ${dateLabel(room.last_message_at)}`,'room-time');copy.append(times);button.append(mark,copy);
      if(unread.has(room.id))button.append(el('span','新','unread'));
      button.onclick=()=>selectRoom(room.id).catch(e=>toast(e.message));if(!user?.guest)row.append(projectGrip(room));row.append(button);
      if(!user?.guest){const menu=el('button','⋯','room-options');menu.title=t('项目选项');menu.setAttribute('aria-label',`${t('项目选项')}: ${room.name}`);menu.onclick=async()=>{try{await selectRoom(room.id);$('menu-room-name').textContent=room.name;const select=$('room-group-select');select.replaceChildren(new Option(t('未分组'),''),...groups.map(g=>new Option(g.name,g.id)));select.value=room.group_id||'';$('room-menu').showModal();}catch(e){toast(e.message);}};row.append(menu);
        row.ondragstart=e=>{if(e.target.closest('button.room-options')){e.preventDefault();return;}draggedRoom=room.id;e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('application/x-multiworks-room',room.id);};
        row.ondragover=e=>{if(draggedRoom){e.preventDefault();row.classList.add('drag-over');}};row.ondragleave=()=>row.classList.remove('drag-over');row.ondragend=()=>{draggedRoom=null;document.querySelectorAll('.drag-over').forEach(n=>n.classList.remove('drag-over'));};
        row.ondrop=async e=>{if(!draggedRoom)return;e.preventDefault();row.classList.remove('drag-over');const source=draggedRoom;draggedRoom=null;await moveProject(source,room.id);};
      }parent.append(row);
    }
  }
}
function setupUser(){
  $('accounts-button').hidden=!!user.guest;$('groups-button').hidden=!!user.guest;$('new-room').hidden=!!user.guest;
  $('current-device').textContent=(user.username?`${user.username} · `:'')+user.name;
  $('current-device').style.borderBottom=`3px ${user.guest?'dashed':'solid'} ${user.color}`;
  $('guest-status').hidden=!user.guest;$('guest-status').textContent=user.guest?`${t('临时账户')} · ${dateLabel(user.expires)}`:'';
  $('device-color').value=user.color||'#36a18b';
}
$('sidebar-collapse').onclick=()=>{const hidden=$('workspace').classList.toggle('collapsed');localStorage.setItem('mw-sidebar-collapsed',String(hidden));};
$('mobile-menu').onclick=()=>{if(matchMedia('(max-width:760px)').matches)document.querySelector('.sidebar').classList.toggle('open');else{$('workspace').classList.remove('collapsed');localStorage.setItem('mw-sidebar-collapsed','false');}};
if(localStorage.getItem('mw-sidebar-collapsed')==='true')$('workspace').classList.add('collapsed');
$('close-room-menu').onclick=()=>$('room-menu').close();
for(const id of ['rename-room','delete-room'])$(id).addEventListener('click',()=>$('room-menu').close());
$('room-group-select').onchange=async()=>{try{await api(`/rooms/${active}`,{method:'PATCH',body:JSON.stringify({groupId:$('room-group-select').value||null})});await refreshRooms();}catch(e){toast(e.message);}};
$('groups-button').onclick=async()=>{await loadGroups();renderGroups();$('group-dialog').showModal();};
function renderGroups(){const list=$('group-list');list.replaceChildren();for(const group of groups){const row=el('div',undefined,'guest-row'),input=el('input');input.value=group.name;input.maxLength=60;const rename=el('button','保存','secondary'),remove=el('button','删除分组','secondary');rename.onclick=async()=>{try{await api(`/groups/${group.id}`,{method:'PATCH',body:JSON.stringify({name:input.value})});await refreshRooms();renderGroups();}catch(e){toast(e.message);}};remove.onclick=async()=>{if(!confirm(t('仅移除分组，群与记录保留。')))return;try{await api(`/groups/${group.id}`,{method:'DELETE'});await refreshRooms();renderGroups();}catch(e){toast(e.message);}};row.append(input,rename,remove);list.append(row);}}
$('group-form').onsubmit=async e=>{e.preventDefault();try{await api('/groups',{method:'POST',body:JSON.stringify({name:$('group-name').value})});$('group-name').value='';await refreshRooms();renderGroups();}catch(e){toast(e.message);}};
$('close-groups').onclick=()=>$('group-dialog').close();
$('preferences-button').onclick=()=>{$('theme-select').value=localStorage.getItem('mw-theme')||'system';$('device-color').value=user.color||'#36a18b';$('preferences-dialog').showModal();};
$('theme-select').onchange=()=>{localStorage.setItem('mw-theme',$('theme-select').value);applyTheme($('theme-select').value);};
$('device-color').onchange=async()=>{try{const result=await api('/device',{method:'PATCH',body:JSON.stringify({color:$('device-color').value})});user.color=result.color;setupUser();toast(t('保存'));}catch(e){toast(e.message);}};
$('close-preferences').onclick=()=>$('preferences-dialog').close();
async function renderGuests(){const accounts=await api('/guests');const list=$('guest-list');list.replaceChildren();if(!accounts.length)list.append(el('p','没有临时账户'));for(const guest of accounts){const row=el('div',undefined,'guest-row'),name=el('strong');name.textContent=guest.username;name.style.borderBottom=`3px dashed ${guest.color}`;row.append(name,el('small',`${t(guest.enabled&&guest.expires>Date.now()&&guest.rooms.length?'激活':'已失效')} · ${dateLabel(guest.expires)} · ${guest.rooms.map(id=>rooms.find(r=>r.id===id)?.name||'').filter(Boolean).join(', ')}`));const actions=el('div',undefined,'guest-actions');const edit=el('button','编辑 / 重新激活','secondary'),disable=el('button','停用','secondary'),remove=el('button','永久删除账户','secondary');edit.onclick=()=>editGuest(guest);disable.onclick=async()=>{try{await api(`/guests/${guest.id}`,{method:'PATCH',body:JSON.stringify({enabled:false})});await renderGuests();toast(t('账户已停用'));}catch(e){toast(e.message);}};remove.onclick=async()=>{if(!confirm(language==='en'?`Delete ${guest.username}? Messages will remain.`:`永久删除账户「${guest.username}」？聊天记录保留。`))return;try{await api(`/guests/${guest.id}`,{method:'DELETE'});await renderGuests();toast(t('账户已删除，聊天记录保留'));}catch(e){toast(e.message);}};actions.append(edit,disable,remove);row.append(actions);list.append(row);}}
function editGuest(guest=null){editingGuest=guest?.id||null;$('guest-username').value=guest?.username||'';$('guest-password').value='';$('guest-password').required=!guest;$('guest-days').value='7';$('guest-color').value=guest?.color||['#36a18b','#637cdd','#bf6db4','#d08036','#3599b0','#ba655d','#819638'][crypto.getRandomValues(new Uint8Array(1))[0]%7];const field=$('guest-rooms');field.replaceChildren(el('legend','授权项目群'));for(const room of rooms){const label=el('label',undefined,'check-room'),input=el('input');input.type='checkbox';input.value=room.id;input.checked=guest?.rooms.includes(room.id)||false;label.append(input,document.createTextNode(room.name));field.append(label);}$('guest-form-title').textContent=t(guest?'编辑 / 重新激活':'创建临时账户');$('guest-edit-dialog').showModal();}
$('accounts-button').onclick=async()=>{try{await renderGuests();$('accounts-dialog').showModal();}catch(e){toast(e.message);}};
$('new-guest').onclick=()=>editGuest();$('close-accounts').onclick=()=>$('accounts-dialog').close();$('cancel-guest').onclick=()=>$('guest-edit-dialog').close();
$('guest-form').onsubmit=async e=>{e.preventDefault();$('save-guest').disabled=true;try{const body={username:$('guest-username').value,password:$('guest-password').value,days:Number($('guest-days').value),color:$('guest-color').value,enabled:true,rooms:[...$('guest-rooms').querySelectorAll('input:checked')].map(n=>n.value)};await api(editingGuest?`/guests/${editingGuest}`:'/guests',{method:editingGuest?'PATCH':'POST',body:JSON.stringify(body)});$('guest-password').value='';$('guest-edit-dialog').close();await renderGuests();toast(t('账户已保存'));}catch(e){toast(e.message);}finally{$('save-guest').disabled=false;}};
