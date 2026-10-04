import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

test('long reconnect uses one recent batch instead of replaying complete history',async()=>{
  const source=readFileSync('public/app.js','utf8');const start=source.indexOf('async function catchUp()'),end=source.indexOf('function connect()',start);
  const calls=[];let renderCount=0;
  const sandbox={active:'project',roomGeneration:3,searchQuery:'',historyWindow:false,hasMore:false,messages:Array.from({length:100},(_,i)=>({id:i+1})),pending:new Map(),api:async url=>{calls.push(url);return Array.from({length:100},(_,i)=>({id:100001+i}));},$:()=>({scrollHeight:1000,scrollTop:800,clientHeight:200}),renderMessages:()=>renderCount++,scrollBottom(){},refreshRooms:async()=>{}};
  vm.createContext(sandbox);vm.runInContext(source.slice(start,end),sandbox);await vm.runInContext('catchUp()',sandbox);
  assert.deepEqual(calls,['/rooms/project/messages']);assert.equal(sandbox.messages.length,100);assert.equal(sandbox.messages[0].id,100001);assert.equal(sandbox.hasMore,true);assert.equal(renderCount,1);
});

test('overlapping catch-up caps the rendered window without discarding server history',async()=>{
  const source=readFileSync('public/app.js','utf8');const start=source.indexOf('async function catchUp()'),end=source.indexOf('function connect()',start);
  const sandbox={active:'project',roomGeneration:1,searchQuery:'',historyWindow:false,hasMore:false,messages:Array.from({length:300},(_,i)=>({id:i+1})),pending:new Map(),api:async()=>Array.from({length:100},(_,i)=>({id:251+i})),$:()=>({scrollHeight:1000,scrollTop:0,clientHeight:200}),renderMessages(){},scrollBottom(){},refreshRooms:async()=>{}};
  vm.createContext(sandbox);vm.runInContext(source.slice(start,end),sandbox);await vm.runInContext('catchUp()',sandbox);
  assert.equal(sandbox.messages.length,300);assert.equal(sandbox.messages[0].id,51);assert.equal(sandbox.messages.at(-1).id,350);assert.equal(sandbox.hasMore,true);
});

test('project drag handlers persist cross-group sorting and new groups default to collapsed',async()=>{
  class Element{
    constructor(){this.children=[];this.dataset={};this.style={};this.classList={add(){},remove(){}};}
    append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=nodes;}setAttribute(){}
    addEventListener(){}
  }
  const elements=new Map(),$=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);},calls=[];
  const sandbox={$,user:{guest:false},rooms:[{id:'a',name:'A',created:1},{id:'b',name:'B',group_id:'archive',created:2}],active:'a',unread:new Set(),localStorage:{getItem:()=>null,setItem(){}},document:{createElement:()=>new Element()},t:text=>text,language:'en',api:async(url,options)=>{calls.push({url,...options});return {ok:true};},refreshRooms:async()=>{},toast(){},selectRoom:async()=>{},matchMedia:()=>({matches:false})};
  vm.createContext(sandbox);vm.runInContext(readFileSync('public/workspace.js','utf8'),sandbox);vm.runInContext("groups=[{id:'archive',name:'Archive'}];renderProjectList()",sandbox);
  const [source,group]=$('rooms').children,target=group.children[1];assert.equal(group.open,false);
  let prevented=0;source.ondragstart({target:{closest:()=>null},dataTransfer:{setData(){}}});target.ondragover({preventDefault(){prevented++;}});await target.ondrop({preventDefault(){prevented++;}});
  assert.equal(prevented,2);assert.equal(calls[0].url,'/rooms/a');assert.deepEqual(JSON.parse(calls[0].body),{groupId:'archive'});assert.equal(calls[1].url,'/rooms/order');assert.deepEqual(JSON.parse(calls[1].body),{ids:['a','b']});
});
