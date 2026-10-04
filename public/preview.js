const $=id=>document.getElementById(id);
function status(message){$('preview-content').replaceChildren();const p=document.createElement('p');p.className='preview-status';p.textContent=message;$('preview-content').append(p);}
async function loadPreview(){
  const id=new URLSearchParams(location.search).get('id');
  if(!/^\d+$/.test(id||'')){status('文件地址无效');return;}
  try{
    const response=await fetch(`/api/files/${id}/preview`);
    const file=await response.json();
    if(response.status===401){$('preview-name').textContent='请先登录';status('文件预览需要登录。');const link=document.createElement('a');link.href=`/?preview=${id}`;link.className='primary';link.textContent='登录工作空间';$('preview-content').append(link);return;}
    if(!response.ok)throw new Error(file.error||'无法打开文件');
    document.title=`${file.name} · MultiWorks`;$('preview-name').textContent=file.name;
    $('preview-meta').textContent=`${(file.size/1024).toFixed(1)} KB · 只读预览`;
    $('preview-download').href=`/api/files/${id}`;$('preview-download').download=file.name;$('preview-download').hidden=false;
    $('preview-content').replaceChildren();
    $('preview-note').textContent=file.note||'文件预览在你的服务中完成，不会发送到第三方。';
    if(file.truncated)$('preview-note').textContent+=' 内容已截取，下载原文件可查看全部。';
    if(file.kind==='pdf'){
      await renderPdf(file);
      $('preview-note').textContent='PDF 在本地服务提供的阅读器中打开。可翻页、缩放，并提取当前页文字；不执行 PDF 脚本。';
    }else if(file.kind==='image'){
      const image=document.createElement('img');image.src=file.url;image.alt=file.name;image.className='preview-image';image.onerror=()=>status('文件内容与格式不匹配，或文件已被删除。');$('preview-content').append(image);
    }else if(file.kind==='text'){
      const text=document.createElement('pre');text.className='document-text';text.textContent=file.text;$('preview-content').append(text);
    }else if(file.kind==='spreadsheet'){
      const tabs=document.createElement('div');tabs.className='sheet-tabs';tabs.setAttribute('role','tablist');
      const panel=document.createElement('div');panel.className='sheet-panel';panel.setAttribute('role','tabpanel');
      function select(sheet,index){
        panel.replaceChildren();const table=document.createElement('table');
        sheet.rows.forEach(cells=>{const row=document.createElement('tr');cells.forEach(value=>{const cell=document.createElement('td');cell.textContent=value;row.append(cell);});table.append(row);});
        panel.append(table);[...tabs.children].forEach((button,i)=>{button.classList.toggle('active',i===index);button.setAttribute('aria-selected',String(i===index));});
        if(sheet.truncated){const p=document.createElement('p');p.textContent='此工作表仅显示前 200 行、30 列。';panel.append(p);}
      }
      file.sheets.forEach((sheet,index)=>{const button=document.createElement('button');button.textContent=sheet.name;button.setAttribute('role','tab');button.onclick=()=>select(sheet,index);tabs.append(button);});
      $('preview-content').append(tabs,panel);if(file.sheets.length)select(file.sheets[0],0);else status('这个工作簿没有可预览的工作表。');
    }else status(file.reason||'此格式暂不支持预览，请下载后打开。');
  }catch(e){$('preview-name').textContent='无法打开文件';status(e.name==='PasswordException'?'此 PDF 需要密码，请下载后用本地阅读器打开。':e.message);}
}
loadPreview();

async function renderPdf(file){
  const {getDocument,GlobalWorkerOptions}=await import('/vendor/pdfjs/pdf.mjs');
  GlobalWorkerOptions.workerSrc='/vendor/pdfjs/pdf.worker.mjs';
  const task=getDocument({url:file.url,isEvalSupported:false,useWasm:false,standardFontDataUrl:'/vendor/pdfjs-fonts/',cMapUrl:'/vendor/pdfjs-cmaps/',cMapPacked:true});
  const pdf=await task.promise;
  let pageNumber=1,zoom=null,renderTask,generation=0;
  const toolbar=document.createElement('div');toolbar.className='pdf-toolbar';
  const previous=document.createElement('button');previous.textContent='上一页';
  const pageInput=document.createElement('input');pageInput.type='number';pageInput.min=1;pageInput.max=pdf.numPages;pageInput.value=1;pageInput.setAttribute('aria-label','PDF 页码');
  const count=document.createElement('span');count.textContent=`/ ${pdf.numPages}`;
  const next=document.createElement('button');next.textContent='下一页';
  const smaller=document.createElement('button');smaller.textContent='−';smaller.setAttribute('aria-label','缩小 PDF');
  const larger=document.createElement('button');larger.textContent='＋';larger.setAttribute('aria-label','放大 PDF');
  const fit=document.createElement('button');fit.textContent='适应宽度';
  toolbar.append(previous,pageInput,count,next,smaller,larger,fit);
  const surface=document.createElement('div');surface.className='pdf-surface';
  const canvas=document.createElement('canvas');canvas.setAttribute('aria-label',file.name);surface.append(canvas);
  const details=document.createElement('details');details.className='pdf-text';const summary=document.createElement('summary');summary.textContent='提取当前页文字';const text=document.createElement('pre');details.append(summary,text);
  $('preview-content').append(toolbar,surface,details);
  async function render(){
    const current=++generation;renderTask?.cancel();
    previous.disabled=pageNumber===1;next.disabled=pageNumber===pdf.numPages;pageInput.value=pageNumber;
    try{
      const page=await pdf.getPage(pageNumber);if(current!==generation)return;
      const original=page.getViewport({scale:1}),fitScale=Math.min(1.5,Math.max(200,surface.clientWidth-32)/original.width);
      const scale=zoom??fitScale;const pixelRatio=Math.min(devicePixelRatio||1,2,4096/(Math.max(original.width,original.height)*scale));
      const viewport=page.getViewport({scale:scale*pixelRatio});canvas.width=Math.floor(viewport.width);canvas.height=Math.floor(viewport.height);canvas.style.width=`${viewport.width/pixelRatio}px`;canvas.style.height=`${viewport.height/pixelRatio}px`;
      renderTask=page.render({canvasContext:canvas.getContext('2d'),viewport});await renderTask.promise;
      if(current!==generation)return;const content=await page.getTextContent();if(current!==generation)return;
      text.textContent=content.items.map(item=>item.str+(item.hasEOL?'\n':' ')).join('')||'本页没有可提取的文字，可能是扫描件。';
    }catch(e){if(e.name!=='RenderingCancelledException')toastPdf('此页无法显示，请下载原文件查看。');}
  }
  function toastPdf(message){text.textContent=message;details.open=true;}
  previous.onclick=()=>{pageNumber--;render();};next.onclick=()=>{pageNumber++;render();};
  pageInput.onchange=()=>{pageNumber=Math.max(1,Math.min(pdf.numPages,Number(pageInput.value)||1));render();};
  smaller.onclick=()=>{zoom=Math.max(.3,(zoom??1)*.8);render();};larger.onclick=()=>{zoom=Math.min(3,(zoom??1)*1.25);render();};fit.onclick=()=>{zoom=null;render();};
  let resizeTimer;const observer=new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(zoom===null)render();},150);});observer.observe(surface);
  window.addEventListener('pagehide',()=>{observer.disconnect();renderTask?.cancel();task.destroy();},{once:true});
  await render();
}
