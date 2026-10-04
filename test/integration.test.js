import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';

test('login, independent rooms, live events, upload/download, retry, revocation and persistence',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'multiworks-test-'));
  const port=32000+Math.floor(Math.random()*10000),origin=`http://127.0.0.1:${port}`;
  let child,ws;
  async function start(){child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:dir,MAX_FILE_MB:'1',PUBLIC_ORIGIN:origin},stdio:['ignore','pipe','pipe']});await Promise.race([once(child.stdout,'data'),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Server startup timed out')),10000).unref())]);}
  async function stop(){const done=once(child,'exit');child.kill();await done;}
  async function request(route,{cookie,body,method='GET',headers={}}={}){return fetch(origin+'/api'+route,{method,headers:{'Content-Type':'application/json','X-Workspace-Request':'1',Origin:origin,...(cookie?{Cookie:cookie}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});}
  try{
    await start();
    assert.equal((await request('/rooms')).status,401);
    assert.equal((await request('/login',{method:'POST',body:{password:'short'}})).status,400);
    const device1=randomUUID(),device2=randomUUID();
    const login1=await request('/login',{method:'POST',body:{password:'a-long-test-password',deviceId:device1,deviceName:'电脑'}});
    assert.equal(login1.status,200);const cookie=login1.headers.get('set-cookie').split(';')[0];
    const login2=await request('/login',{method:'POST',body:{password:'a-long-test-password',deviceId:device2,deviceName:'手机'}});const cookie2=login2.headers.get('set-cookie').split(';')[0];
    const initial=(await (await request('/rooms',{cookie})).json())[0];
    const room=await (await request('/rooms',{cookie,method:'POST',body:{name:'项目 B'}})).json();
    ws=new WebSocket(`ws://127.0.0.1:${port}/ws`,{headers:{Cookie:cookie2,Origin:origin}});await once(ws,'open');
    const event=once(ws,'message');
    const clientId=randomUUID();
    const sent=await (await request(`/rooms/${initial.id}/messages`,{cookie,method:'POST',body:{body:'测试实时同步 <script>alert(1)</script>',clientId}})).json();
    const live=JSON.parse((await event)[0].toString());assert.equal(live.message.id,sent.id);
    const retry=await (await request(`/rooms/${initial.id}/messages`,{cookie,method:'POST',body:{body:'重复请求',clientId}})).json();assert.equal(retry.id,sent.id);
    assert.equal((await (await request(`/rooms/${room.id}/messages`,{cookie:cookie2})).json()).length,0);
    assert.equal((await request(`/rooms/${initial.id}/messages`,{cookie,method:'POST',body:{body:'blocked',clientId:randomUUID()},headers:{Origin:'https://evil.example'}})).status,403);
    const form=new FormData();form.append('file',new Blob(['pdf-content']), '工作.pdf');form.append('clientId',randomUUID());
    const uploaded=await fetch(origin+`/api/rooms/${room.id}/files`,{method:'POST',headers:{Cookie:cookie,'X-Workspace-Request':'1',Origin:origin},body:form});assert.equal(uploaded.status,200);const file=await uploaded.json();assert.equal(file.file_name,'工作.pdf');
    assert.equal((await request(`/files/${file.id}`)).status,401);
    const download=await request(`/files/${file.id}`,{cookie:cookie2});assert.equal(await download.text(),'pdf-content');assert.match(download.headers.get('content-disposition'),/attachment/);
    const range=await request(`/files/${file.id}`,{cookie:cookie2,headers:{Range:'bytes=0-2'}});assert.equal(range.status,206);assert.equal(await range.text(),'pdf');
    const large=new FormData();large.append('file',new Blob([new Uint8Array(1048577)]),'large.zip');large.append('clientId',randomUUID());assert.equal((await fetch(origin+`/api/rooms/${room.id}/files`,{method:'POST',headers:{Cookie:cookie,'X-Workspace-Request':'1',Origin:origin},body:large})).status,413);
    await request(`/devices/${device2}/sessions`,{cookie,method:'DELETE'});assert.equal((await request('/rooms',{cookie:cookie2})).status,401);
    ws.close();await stop();await start();
    const persisted=await (await request(`/rooms/${room.id}/messages`,{cookie})).json();assert.equal(persisted[0].file_name,'工作.pdf');
    assert.equal(await (await request(`/files/${file.id}`,{cookie})).text(),'pdf-content');
    assert.equal((await (await request(`/rooms/${room.id}/messages?q=${encodeURIComponent('工作')}`,{cookie})).json()).length,1);
    assert.equal((await (await request(`/rooms/${initial.id}/messages?q=${encodeURIComponent('工作')}`,{cookie})).json()).length,0);
    assert.equal((await request(`/messages/${file.id}`,{cookie,method:'DELETE'})).status,200);
    assert.equal((await request(`/files/${file.id}`,{cookie})).status,404);
  }finally{ws?.terminate();if(child?.exitCode===null)await stop();await rm(dir,{recursive:true,force:true});}
});
