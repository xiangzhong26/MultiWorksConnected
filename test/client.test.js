import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

function client(){
  class Element{
    constructor(){this.children=[];this.open=false;this.listeners={};this.value='';this.classList={add(){},remove(){},toggle(){}};}
    append(...children){this.children.push(...children);}
    replaceChildren(...children){this.children=children;}
    setAttribute(){}
    addEventListener(name,callback){this.listeners[name]=callback;}
    showModal(){this.open=true;}
    close(){this.open=false;this.listeners.close?.();}
  }
  const elements=new Map(),events={},uploaded=[];
  const $=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const sandbox={$ ,document:{createElement:()=>new Element(),addEventListener:(name,callback)=>events[name]=callback},user:{id:'device'},active:'room-a',rooms:[{id:'room-a',name:'项目 A'},{id:'room-b',name:'项目 B'}],window:{maxFileMB:100},location:{origin:'https://work.example.com'},URL,setTimeout,clearTimeout,size:n=>`${n} B`,queueFiles:(files,room)=>uploaded.push({files,room}),toast(){},pending:new Map(),sessionStorage:{setItem(){}},drafts:{}};
  vm.createContext(sandbox);vm.runInContext(readFileSync('public/features.js','utf8'),sandbox);
  return {sandbox,$,events,uploaded,run:code=>vm.runInContext(code,sandbox)};
}
test('drop over the composer prevents navigation and waits for explicit confirmation',()=>{
  const c=client(),file={name:'报告.pdf',size:1234};let prevented=0;
  const event={target:{id:'text'},dataTransfer:{types:['Files'],files:[file]},preventDefault(){prevented++;}};
  c.events.dragover(event);c.events.drop(event);
  assert.equal(prevented,2);assert.equal(c.$('upload-dialog').open,true);assert.equal(c.uploaded.length,0);
  assert.match(c.$('upload-target').textContent,/项目 A/);
  c.sandbox.active='room-b';c.$('confirm-upload').onclick();
  assert.equal(c.uploaded.length,1);assert.equal(c.uploaded[0].room,'room-a');assert.equal(c.uploaded[0].files[0],file);
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
