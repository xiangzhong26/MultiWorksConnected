import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

function client(){
  class Element{
    constructor(tag='div'){this.tagName=tag;this.children=[];this.open=false;this.hidden=false;this.listeners={};this.attributes={};this.value='';this.classList={add(){},remove(){},toggle(){}};}
    remove(){this.removed=true;}
    append(...children){this.children.push(...children);}
    prepend(...children){this.children.unshift(...children);}
    replaceChildren(...children){this.children=children;}
    setAttribute(name,value){this.attributes[name]=value;}
    removeAttribute(name){delete this.attributes[name];delete this[name];}
    setRangeText(text,start,end){this.value=this.value.slice(0,start)+text+this.value.slice(end);}
    addEventListener(name,callback){this.listeners[name]=callback;}
    showModal(){this.open=true;}
    close(){this.open=false;this.listeners.close?.();}
  }
  const elements=new Map(),events={},uploaded=[],notices=[],urls=[],revoked=[];
  class LocalURL extends URL {static createObjectURL(){const url=`blob:test-${urls.length}`;urls.push(url);return url;}static revokeObjectURL(url){revoked.push(url);}}
  const $=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const sandbox={$ ,document:{createElement:tag=>new Element(tag),addEventListener:(name,callback)=>events[name]=callback},user:{id:'device'},active:'room-a',rooms:[{id:'room-a',name:'项目 A'},{id:'room-b',name:'项目 B'}],window:{maxFileMB:100},location:{origin:'https://work.example.com'},URL:LocalURL,File,setTimeout,clearTimeout,size:n=>`${n} B`,queueFiles:(files,room)=>uploaded.push({files,room}),toast:message=>notices.push(message),pending:new Map(),sessionStorage:{setItem(){}},drafts:{}};
  vm.createContext(sandbox);vm.runInContext(readFileSync('public/features.js','utf8'),sandbox);
  return {sandbox,$,events,uploaded,notices,urls,revoked,run:code=>vm.runInContext(code,sandbox)};
}

test('pasted screenshot shows a local thumbnail, waits for confirmation and releases blob URLs',()=>{
  const c=client(),image=new File(['screenshot-fixture'],'image.png',{type:'image/png'});let prevented=0;
  c.$('text').listeners.paste({target:c.$('text'),clipboardData:{items:[{kind:'file',getAsFile:()=>image}],files:[image],getData:()=>''},preventDefault(){prevented++;}});
  assert.equal(prevented,1);assert.equal(c.uploaded.length,0);assert.equal(c.$('upload-dialog').open,true);
  assert.equal(c.$('selected-files').children.length,1); // items and files must not duplicate the screenshot.
  const thumb=c.$('selected-files').children[0].children[0];assert.equal(thumb.tagName,'img');assert.match(thumb.src,/^blob:/);
  assert.match(c.run('stagedFiles[0].name'),/^clipboard-.*\.png$/);
  c.$('confirm-upload').onclick();assert.equal(c.uploaded.length,1);assert.equal(c.uploaded[0].files[0].type,'image/png');assert.equal(c.uploaded[0].room,'room-a');assert.deepEqual(c.revoked,c.urls);
});

test('plain and rich text paste keeps native behavior; clipboard file fallback still confirms',()=>{
  const c=client();let prevented=0;
  c.$('text').listeners.paste({target:c.$('text'),clipboardData:{items:[{kind:'string',type:'text/html'}],files:[],getData:()=>'<text>'},preventDefault(){prevented++;}});
  assert.equal(prevented,0);assert.equal(c.$('upload-dialog').open,false);
  const file=new File(['notes'],'notes.txt',{type:'text/plain'});
  c.$('text').listeners.paste({target:c.$('text'),clipboardData:{items:[],files:[file],getData:()=>''},preventDefault(){prevented++;}});
  assert.equal(prevented,1);assert.equal(c.$('upload-dialog').open,true);assert.equal(c.uploaded.length,0);c.$('cancel-upload').onclick();assert.equal(c.uploaded.length,0);
});

test('inline images use the seven-day boundary, explicit expansion, cached nodes and cleanup',()=>{
  const c=client();c.sandbox.recent={id:50,file_key:'key',file_name:'截图.PNG',file_size:100,created:Date.now()};
  const recent=c.run('createFileCard(recent)'),view=recent.children[1],eye=recent.children[2].children[0],image=view.children[0].children[0];
  assert.equal(view.hidden,false);assert.equal(image.src,'/api/files/50/content');assert.equal(image.loading,'lazy');assert.equal(image.decoding,'async');
  eye.onclick();assert.equal(view.hidden,true);eye.onclick();assert.equal(view.hidden,false);
  const rerendered=c.run('createFileCard(recent)');assert.equal(rerendered.children[1].children[0].children[0],image);
  c.sandbox.old={id:51,file_key:'key-old',file_name:'older.jpg',file_size:100,created:Date.now()-7*86400000};
  const old=c.run('createFileCard(old)'),oldView=old.children[1],oldEye=old.children[2].children[0];assert.equal(oldView.hidden,true);assert.equal(oldView.children.length,0);
  oldEye.onclick();assert.equal(oldView.hidden,false);assert.equal(oldView.children[0].children[0].src,'/api/files/51/content');assert.equal(oldEye.attributes['aria-expanded'],'true');
  assert.equal(c.run('createFileCard(old)').children[1],oldView);
  c.run('pruneInlineImages([])');assert.equal(c.run('inlineImageViews.size'),0);assert.equal(c.run('expandedInlineImages.size'),0);assert.equal(c.run('createFileCard(old)').children[1].children.length,0);
  c.sandbox.svg={id:52,file_key:'key-svg',file_name:'untrusted.svg',file_size:100,created:Date.now()};assert.equal(c.run('createFileCard(svg)').children.length,2);
});
test('drop over the composer prevents navigation and waits for explicit confirmation',async()=>{
  const c=client(),file={name:'报告.pdf',size:1234};let prevented=0;
  const event={target:{id:'text'},dataTransfer:{types:['Files'],files:[file]},preventDefault(){prevented++;}};
  c.events.dragover(event);await c.events.drop(event);
  assert.equal(prevented,2);assert.equal(c.$('upload-dialog').open,true);assert.equal(c.uploaded.length,0);
  assert.match(c.$('upload-target').textContent,/项目 A/);
  c.sandbox.active='room-b';c.$('confirm-upload').onclick();
  assert.equal(c.uploaded.length,1);assert.equal(c.uploaded[0].room,'room-a');assert.equal(c.uploaded[0].files[0],file);
});
test('folders and mixed file/folder drops are rejected without confirmation or upload',async()=>{
  const c=client();
  await c.events.drop({dataTransfer:{types:['Files'],files:[{name:'目录',size:0},{name:'正常.pdf',size:10}],items:[{kind:'file',webkitGetAsEntry:()=>({isDirectory:true})}]},preventDefault(){}});
  assert.equal(c.$('upload-dialog').open,false);assert.equal(c.uploaded.length,0);assert.match(c.notices[0],/不支持上传文件夹.*压缩/);
  await c.events.drop({dataTransfer:{types:['Files'],files:[],items:[{kind:'file',getAsFileSystemHandle:async()=>({kind:'directory'})}]},preventDefault(){}});
  assert.equal(c.$('upload-dialog').open,false);assert.equal(c.uploaded.length,0);assert.match(c.notices.at(-1),/压缩/);
});
test('unreadable drop is rejected, while legitimate empty files are allowed',async()=>{
  const c=client();
  const drop=file=>c.events.drop({dataTransfer:{types:['Files'],files:[file]},preventDefault(){}});
  await drop({name:'folder',size:0,slice:()=>({arrayBuffer:async()=>{throw new Error('unreadable');}})});
  assert.equal(c.$('upload-dialog').open,false);assert.match(c.notices.at(-1),/无法读取/);
  await drop({name:'empty.txt',size:0,slice:()=>({arrayBuffer:async()=>new ArrayBuffer(0)})});
  assert.equal(c.$('upload-dialog').open,true);assert.equal(c.uploaded.length,0);
});
test('a failed upload keeps separate retry and cancel buttons; cancel aborts and removes it',async()=>{
  const c=client(),requests=[];
  c.sandbox.crypto={randomUUID:()=> 'test-client-id'};
  c.sandbox.FormData=class {append(){}};
  c.sandbox.XMLHttpRequest=class {
    constructor(){this.upload={};requests.push(this);}open(){}setRequestHeader(){}send(){}abort(){this.aborted=true;this.onabort?.();}
  };
  c.run(readFileSync('public/uploads.js','utf8'));
  c.sandbox.files=[{name:'正常.pdf',size:100,slice:()=>({arrayBuffer:async()=>new ArrayBuffer(1)})}];
  c.run('queueFiles(files)');await new Promise(resolve=>setImmediate(resolve));
  requests[0].onerror();await new Promise(resolve=>setImmediate(resolve));
  const row=c.$('transfers').children[0],retry=row.children[2],cancel=row.children[3];
  assert.equal(retry.hidden,false);assert.equal(cancel.hidden,false);assert.equal(cancel.textContent,'取消');
  retry.onclick();await new Promise(resolve=>setImmediate(resolve));assert.equal(requests.length,2);
  cancel.onclick();assert.equal(requests[1].aborted,true);assert.equal(row.removed,true);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(c.run('activeTransfers.size'),0);
});
test('cancel and file removal do not upload, and unsupported oversized files are rejected',()=>{
  const c=client();c.sandbox.files=[{name:'错选.zip',size:10}];c.run('stageFiles(files)');c.$('cancel-upload').onclick();assert.equal(c.uploaded.length,0);
  c.run('stageFiles(files)');c.$('selected-files').children[0].children[1].onclick();assert.equal(c.$('confirm-upload').disabled,true);assert.equal(c.uploaded.length,0);
  c.$('cancel-upload').onclick();c.sandbox.files=[{name:'过大.zip',size:101*1048576}];c.run('stageFiles(files)');assert.equal(c.$('upload-dialog').open,false);
});
test('attachment drag sets a download payload and dropping it back never uploads',()=>{
  const c=client();c.sandbox.message={id:42,file_name:'报告.pdf',file_size:100};
  const card=c.run('createFileCard(message)'),payload=new Map();
  card.children[0].ondragstart({dataTransfer:{setData:(key,value)=>payload.set(key,value)}});
  assert.equal(payload.get('DownloadURL'),'application/octet-stream:报告.pdf:https://work.example.com/api/files/42');
  let prevented=false;c.events.drop({dataTransfer:{types:[...payload.keys()],files:[]},preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.equal(c.uploaded.length,0);assert.equal(c.$('upload-dialog').open,false);
});
