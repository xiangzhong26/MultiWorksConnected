import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID,scryptSync,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import WebSocket from 'ws';

test('migration, guest scopes, revocation, expiration, history retention, groups and file filters',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'multiworks-access-')),port=43000+Math.floor(Math.random()*7000),origin=`http://127.0.0.1:${port}`;
  // A database from the previous release must migrate without losing messages.
  const legacy=new DatabaseSync(path.join(dir,'workspaces.sqlite'));
  legacy.exec(`CREATE TABLE account(id INTEGER PRIMARY KEY,salt TEXT NOT NULL,hash TEXT NOT NULL);CREATE TABLE devices(id TEXT PRIMARY KEY,name TEXT NOT NULL,last_seen INTEGER NOT NULL);CREATE TABLE sessions(token TEXT PRIMARY KEY,device_id TEXT NOT NULL,expires INTEGER NOT NULL);CREATE TABLE rooms(id TEXT PRIMARY KEY,name TEXT NOT NULL,created INTEGER NOT NULL);CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,room_id TEXT NOT NULL,device_id TEXT NOT NULL,device_name TEXT NOT NULL,body TEXT NOT NULL DEFAULT '',file_key TEXT,file_name TEXT,file_size INTEGER,client_id TEXT UNIQUE,created INTEGER NOT NULL);INSERT INTO rooms VALUES('legacy','Legacy project',1);INSERT INTO messages(room_id,device_id,device_name,body,created) VALUES('legacy','old-device','Old device','Retained forever',1);`);
  legacy.prepare('INSERT INTO account VALUES(1,?,?)').run('legacy-test-salt',scryptSync('administrator-password','legacy-test-salt',64).toString('hex'));
  legacy.prepare('INSERT INTO devices VALUES(?,?,?)').run('old-device','Old device',1);
  legacy.prepare('INSERT INTO sessions VALUES(?,?,?)').run(createHash('sha256').update('legacy-test-session').digest('hex'),'old-device',Date.now()+86400000);legacy.close();
  const child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:dir,PUBLIC_ORIGIN:origin},stdio:['ignore','pipe','pipe']});let ws;
  async function req(route,cookie,body,method=body?'POST':'GET'){return fetch(origin+'/api'+route,{method,headers:{'Content-Type':'application/json','X-Workspace-Request':'1',Origin:origin,...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});}
  async function json(route,cookie,body,method){const response=await req(route,cookie,body,method);assert.equal(response.status,200,await response.clone().text());return response.json();}
  async function login(username='',password='administrator-password'){const r=await req('/login',null,{username,password,deviceId:randomUUID(),deviceName:'Browser'});assert.equal(r.status,200,await r.clone().text());return r.headers.get('set-cookie').split(';')[0];}
  try{
    await Promise.race([once(child.stdout,'data'),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Startup timed out')),10000).unref())]);
    assert.equal((await json('/status','mw_session=legacy-test-session')).user.name,'Old device');
    const admin=await login();assert.equal((await json('/rooms/legacy/messages',admin))[0].body,'Retained forever');
    const a=await json('/rooms',admin,{name:'Shared'}),b=await json('/rooms',admin,{name:'Private'});
    const group=await json('/groups',admin,{name:'Archived'});await json(`/rooms/${a.id}`,admin,{groupId:group.id},'PATCH');
    await json('/rooms/order',admin,{ids:[b.id,a.id,...(await json('/rooms',admin)).filter(r=>![b.id,a.id].includes(r.id)).map(r=>r.id)]});const ordered=await json('/rooms',admin);assert.equal(ordered[0].id,b.id);assert.equal(ordered[1].group_name,'Archived');
    const guest=await json('/guests',admin,{username:'collaborator',password:'guest-long-password',days:1,rooms:[a.id]});
    assert.equal((await req('/guests',admin,{username:'collaborator',password:'guest-long-password',days:7,rooms:[]})).status,409);
    assert.equal((await req('/guests',admin,{username:'bad',password:'guest-long-password',days:2,rooms:[]})).status,400);
    let cookie=await login('collaborator','guest-long-password');const state=await json('/status',cookie);assert.equal(state.user.guest,true);assert.match(state.user.color,/^#[0-9a-f]{6}$/i);
    assert.deepEqual((await json('/rooms',cookie)).map(r=>r.id),[a.id]);
    for(const route of ['/guests','/devices','/groups',`/rooms/${b.id}/messages`])assert.equal((await req(route,cookie)).status,403);
    for(const [route,method,body] of [['/rooms','POST',{name:'Forbidden'}],[`/rooms/${a.id}`,'PATCH',{name:'Forbidden'}],[`/rooms/${a.id}`,'DELETE',undefined],['/rooms/order','POST',{ids:[a.id]}]])assert.equal((await req(route,cookie,body,method)).status,403);
    for(const [route,method,body] of [['/rooms/','POST',{name:'Forbidden'}],[`/rooms/${a.id}/`,'PATCH',{name:'Forbidden'}],[`/rooms/${a.id}/`,'DELETE',undefined],['/rooms/order/','POST',{ids:[a.id]}]])assert.equal((await req(route,cookie,body,method)).status,403);
    const privateMessage=await json(`/rooms/${b.id}/messages`,admin,{body:'private needle',clientId:randomUUID()});
    const sharedMessage=await json(`/rooms/${a.id}/messages`,cookie,{body:'shared needle',clientId:randomUUID()});assert.equal(sharedMessage.guest_id,guest.id);assert.equal(sharedMessage.sender_username,'collaborator');
    assert.equal((await req(`/messages/${privateMessage.id}/context`,cookie)).status,403);assert.equal((await json('/search?q=needle',cookie)).length,1);
    const adminMessage=await json(`/rooms/${a.id}/messages`,admin,{body:'owner message',clientId:randomUUID()});assert.equal((await req(`/messages/${adminMessage.id}`,cookie,undefined,'DELETE')).status,403);
    async function upload(roomId,name,contents='fixture-content',uploader=admin){const form=new FormData();form.append('file',new Blob([contents]),name);form.append('clientId',randomUUID());const response=await fetch(origin+`/api/rooms/${roomId}/files`,{method:'POST',headers:{Cookie:uploader,'X-Workspace-Request':'1',Origin:origin},body:form});assert.equal(response.status,200);return response.json();}
    const sharedFile=await upload(a.id,'shared.pdf'),privateFile=await upload(b.id,'secret.txt');
    const emptyFile=await upload(a.id,'empty.txt','');assert.equal(emptyFile.file_size,0);
    for(const suffix of ['', '/preview','/content'])assert.equal((await req(`/files/${privateFile.id}${suffix}`,cookie)).status,403);
    const encodedId='%'+String(privateFile.id)[0].charCodeAt(0).toString(16)+String(privateFile.id).slice(1);
    for(const suffix of ['', '/preview','/content'])assert.equal((await req(`/files/${encodedId}${suffix}`,cookie)).status,403);
    assert.equal((await req(`/files/000${privateFile.id}`,cookie)).status,403);
    assert.notEqual((await req('/GUESTS',cookie)).status,200);
    const filtered=await json('/files?stats=1&ext=pdf',cookie);assert.equal(filtered.count,1);assert.equal(filtered.rows[0].id,sharedFile.id);assert.equal(filtered.bytes,15);
    assert.equal((await json(`/files?stats=1&room=${b.id}`,cookie)).count,0);assert.equal((await json('/files?stats=1&min=1000',admin)).count,0);assert.equal((await json('/files?stats=1&to=1',admin)).count,0);
    // Same display name across accounts must keep independent bytes and deletion targets.
    const ownerCopy=await upload(a.id,'same-name.txt','owner contents');
    const guestCopy=await upload(a.id,'same-name.txt','guest contents',cookie);
    assert.equal(ownerCopy.file_name,guestCopy.file_name);
    assert.notEqual(ownerCopy.id,guestCopy.id);assert.notEqual(ownerCopy.file_key,guestCopy.file_key);
    assert.equal((await req(`/files/${ownerCopy.id}`,cookie)).status,200);
    assert.equal(await (await req(`/files/${ownerCopy.id}`,admin)).text(),'owner contents');
    assert.equal(await (await req(`/files/${guestCopy.id}`,cookie)).text(),'guest contents');
    await json(`/messages/${guestCopy.id}`,cookie,undefined,'DELETE');
    assert.equal(existsSync(path.join(dir,'files',guestCopy.file_key)),false);
    assert.equal(existsSync(path.join(dir,'files',ownerCopy.file_key)),true);
    assert.equal(await (await req(`/files/${ownerCopy.id}`,admin)).text(),'owner contents');
    ws=new WebSocket(`ws://127.0.0.1:${port}/ws`,{headers:{Cookie:cookie,Origin:origin}});await once(ws,'open');const events=[];ws.on('message',raw=>events.push(JSON.parse(raw)));
    await json(`/rooms/${b.id}/messages`,admin,{body:'secret live',clientId:randomUUID()});await json(`/rooms/${a.id}/messages`,admin,{body:'public live',clientId:randomUUID()});await new Promise(resolve=>setTimeout(resolve,80));assert.equal(events.filter(e=>e.type==='message').length,1);assert.equal(events[0].message.body,'public live');
    const closed=once(ws,'close');await json(`/guests/${guest.id}`,admin,{enabled:false},'PATCH');assert.equal((await closed)[0],4001);assert.equal((await req('/rooms',cookie)).status,401);
    const invalid=await req('/login',null,{username:'collaborator',password:'guest-long-password'});assert.equal(invalid.status,401);
    await json(`/guests/${guest.id}`,admin,{days:3,enabled:true,rooms:[b.id]},'PATCH');cookie=await login('collaborator','guest-long-password');assert.equal((await req(`/rooms/${a.id}/messages`,cookie)).status,403);assert.equal((await json('/rooms',cookie))[0].id,b.id);
    await json(`/guests/${guest.id}`,admin,{rooms:[]},'PATCH');assert.equal((await req('/rooms',cookie)).status,401);
    assert.equal((await req('/login',null,{username:'collaborator',password:'guest-long-password'})).status,401);
    await json(`/guests/${guest.id}`,admin,{days:5,rooms:[b.id]},'PATCH');cookie=await login('collaborator','guest-long-password');
    const database=new DatabaseSync(path.join(dir,'workspaces.sqlite'));database.prepare('UPDATE guests SET expires=? WHERE id=?').run(Date.now()-1,guest.id);database.close();assert.equal((await req('/rooms',cookie)).status,401);
    await json(`/guests/${guest.id}`,admin,undefined,'DELETE');const history=await json(`/rooms/${a.id}/messages`,admin);assert.equal(history.find(m=>m.id===sharedMessage.id).sender_username,'collaborator');
    await json(`/groups/${group.id}`,admin,undefined,'DELETE');assert.equal((await json('/rooms',admin)).find(r=>r.id===a.id).group_id,null);assert.ok((await json(`/rooms/${a.id}/messages`,admin)).length);
    assert.ok(existsSync(path.join(dir,'files',sharedFile.file_key)));await json(`/messages/${sharedFile.id}`,admin,undefined,'DELETE');assert.equal(existsSync(path.join(dir,'files',sharedFile.file_key)),false);
  }finally{ws?.terminate();const exit=once(child,'exit');child.kill();await exit;await rm(dir,{recursive:true,force:true});}
});
