const $=id=>document.getElementById(id);
function status(message){$('preview-content').replaceChildren();const p=document.createElement('p');p.className='preview-status';p.textContent=t(message);$('preview-content').append(p);}
async function loadPreview(){
  const id=new URLSearchParams(location.search).get('id');
  if(!/^\d+$/.test(id||'')){status(t('文件地址无效'));return;}
  try{
    const response=await fetch(`/api/files/${id}/preview`);
    const file=await response.json();
    if(response.status===401){$('preview-name').textContent=t('请先登录');status(t('文件预览需要登录。'));const link=document.createElement('a');link.href=`/?preview=${id}`;link.className='primary';link.textContent=t('登录工作空间');$('preview-content').append(link);return;}
    if(!response.ok)throw new Error(file.error||'无法打开文件');
    document.title=`${file.name} · MultiWorks`;$('preview-name').textContent=file.name;
    $('preview-meta').textContent=`${(file.size/1024).toFixed(1)} KB · ${language==='en'?'Read-only preview':'只读预览'}`;
    $('preview-download').href=`/api/files/${id}`;$('preview-download').download=file.name;$('preview-download').hidden=false;
    $('preview-content').replaceChildren();
    $('preview-note').textContent=t(file.note||'文件预览在你的服务中完成，不会发送到第三方。');
    if(file.truncated)$('preview-note').textContent+=t(' 内容已截取，下载原文件可查看全部。');
    if(file.kind==='pdf'){
      await renderPdf(file);
      $('preview-note').textContent=t('PDF 支持连续上下滚动、缩放与页码跳转；页面按需加载，不执行 PDF 脚本。');
    }else if(file.kind==='image'){
      const image=document.createElement('img');image.src=file.url;image.alt=file.name;image.className='preview-image';image.onerror=()=>status(t('文件内容与格式不匹配，或文件已被删除。'));$('preview-content').append(image);
    }else if(file.kind==='text'){
      const text=document.createElement('pre');text.className='document-text';text.textContent=file.text;$('preview-content').append(text);
    }else if(file.kind==='spreadsheet'){
      const tabs=document.createElement('div');tabs.className='sheet-tabs';tabs.setAttribute('role','tablist');
      const panel=document.createElement('div');panel.className='sheet-panel';panel.setAttribute('role','tabpanel');
      function select(sheet,index){
        panel.replaceChildren();const table=document.createElement('table');
        sheet.rows.forEach(cells=>{const row=document.createElement('tr');cells.forEach(value=>{const cell=document.createElement('td');cell.textContent=value;row.append(cell);});table.append(row);});
        panel.append(table);[...tabs.children].forEach((button,i)=>{button.classList.toggle('active',i===index);button.setAttribute('aria-selected',String(i===index));});
        if(sheet.truncated){const p=document.createElement('p');p.textContent=t('此工作表仅显示前 200 行、30 列。');panel.append(p);}
      }
      file.sheets.forEach((sheet,index)=>{const button=document.createElement('button');button.textContent=sheet.name;button.setAttribute('role','tab');button.onclick=()=>select(sheet,index);tabs.append(button);});
      $('preview-content').append(tabs,panel);if(file.sheets.length)select(file.sheets[0],0);else status(t('这个工作簿没有可预览的工作表。'));
    }else status(t(file.reason||'此格式暂不支持预览，请下载后打开。'));
  }catch(e){$('preview-name').textContent=t('无法打开文件');status(e.name==='PasswordException'?'此 PDF 需要密码，请下载后用本地阅读器打开。':e.message);}
}
loadPreview();

async function renderPdf(file){
  const {getDocument,GlobalWorkerOptions}=await import('/vendor/pdfjs/pdf.mjs');
  GlobalWorkerOptions.workerSrc='/vendor/pdfjs/pdf.worker.mjs';
  const task=getDocument({url:file.url,isEvalSupported:false,useWasm:false,standardFontDataUrl:'/vendor/pdfjs-fonts/',cMapUrl:'/vendor/pdfjs-cmaps/',cMapPacked:true});
  const pdf=await task.promise;
  const {mountPdfReader}=await import('/pdf-reader.js');
  await mountPdfReader(pdf, $('preview-content'), file.name, t, task);
}
