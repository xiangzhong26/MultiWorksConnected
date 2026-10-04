const transferQueue=[];
let runningUploads=0;

function cancelTransfer(item){
  item.cancelled=true;
  item.xhr?.abort();
  item.row.remove();
  activeTransfers.delete(item);
}

function queueFiles(files,targetRoom=active){
  if(!targetRoom)return;
  for(const file of files){
    if(file.size>window.maxFileMB*1048576){toast(typeof language!=='undefined'&&language==='en'?`${file.name} exceeds ${window.maxFileMB} MB`:`${file.name} 超过 ${window.maxFileMB} MB`);continue;}
    const item={file,roomId:targetRoom,clientId:crypto.randomUUID()};
    const row=document.createElement('div');row.className='transfer';
    const label=document.createElement('span');label.textContent=`${file.name} · ${tr('等待上传')}`;
    const progress=document.createElement('progress');progress.max=100;progress.value=0;
    const retry=document.createElement('button');retry.className='secondary';retry.textContent=tr('重试');retry.hidden=true;
    const cancel=document.createElement('button');cancel.className='secondary';cancel.textContent=tr('取消');
    row.append(label,progress,retry,cancel);$('transfers').append(row);
    Object.assign(item,{row,label,progress,retry,cancel});activeTransfers.add(item);
    cancel.onclick=()=>cancelTransfer(item);
    retry.onclick=()=>{if(item.cancelled)return;retry.hidden=true;retry.disabled=true;transferQueue.push(item);pumpUploads();};
    transferQueue.push(item);
  }
  pumpUploads();
}

function pumpUploads(){
  while(runningUploads<2&&transferQueue.length){
    const item=transferQueue.shift();if(item.cancelled)continue;
    runningUploads++;uploadFile(item).finally(()=>{runningUploads--;pumpUploads();});
  }
}

async function uploadFile(item){
  item.retry.hidden=true;item.retry.disabled=false;item.progress.value=0;
  try{await item.file.slice(0,1).arrayBuffer();}
  catch{item.label.textContent=`${item.file.name} · ${tr('无法读取文件，不支持文件夹，请压缩后重新选择')}`;return;}
  if(item.cancelled)return;
  return new Promise(resolve=>{
    const xhr=new XMLHttpRequest();item.xhr=xhr;
    const form=new FormData();
    let settled=false;
    function finish(){if(!settled){settled=true;resolve();}}
    function fail(message,retryable=true){
      if(!item.cancelled){item.label.textContent=`${item.file.name} · ${tr(message)}`;item.retry.hidden=!retryable;item.retry.disabled=false;}
      finish();
    }
    try{
      form.append('file',item.file);form.append('clientId',item.clientId);
      xhr.open('POST',`/api/rooms/${item.roomId}/files`);xhr.setRequestHeader('X-Workspace-Request','1');
      item.label.textContent=`${item.file.name} · ${tr('正在上传')}`;
      xhr.upload.onprogress=e=>{if(!item.cancelled&&e.lengthComputable){const percent=Math.round(e.loaded/e.total*100);item.progress.value=percent;item.label.textContent=`${item.file.name} · ${percent===100?tr('正在保存'):percent+'%'}`;}};
      xhr.onload=()=>{
        if(item.cancelled){finish();return;}
        let result;try{result=JSON.parse(xhr.responseText);}catch{return fail('服务器响应异常');}
        if(xhr.status>=200&&xhr.status<300){receive(result);item.row.remove();activeTransfers.delete(item);finish();}
        else{if(xhr.status===401)showLogin();fail(result.error||'上传失败',![400,401,403,404,413].includes(xhr.status));}
      };
      xhr.onerror=()=>fail('网络中断');
      xhr.onabort=()=>{activeTransfers.delete(item);finish();};
      xhr.send(form);
    }catch{fail('无法读取文件，请重新选择；文件夹需先压缩',false);}
  });
}
