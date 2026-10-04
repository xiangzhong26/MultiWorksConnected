import { migrate, allowed, scope, publicUser, installCollaboration, colorFor } from './collaboration.js';
import express from 'express';
import multer from 'multer';
import { WebSocketServer } from 'ws';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { open } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';

const root = path.dirname(fileURLToPath(import.meta.url));
const data = path.resolve(process.env.DATA_DIR || './data');
mkdirSync(path.join(data, 'files'), { recursive: true });
const db = new DatabaseSync(path.join(data, 'workspaces.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS account(id INTEGER PRIMARY KEY CHECK(id=1),salt TEXT NOT NULL,hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,name TEXT NOT NULL,last_seen INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,device_id TEXT NOT NULL REFERENCES devices(id),expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY,name TEXT NOT NULL,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT,room_id TEXT NOT NULL REFERENCES rooms(id),device_id TEXT NOT NULL,device_name TEXT NOT NULL,body TEXT NOT NULL DEFAULT '',file_key TEXT,file_name TEXT,file_size INTEGER,client_id TEXT UNIQUE,created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS messages_room_id ON messages(room_id,id);`);
migrate(db);
const app = express();
app.disable('x-powered-by');
app.set('case sensitive routing',true);
app.use((req,res,next)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','same-origin');
  res.setHeader('Content-Security-Policy',"default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if(req.path.startsWith('/api')) res.setHeader('Cache-Control','no-store');
  if(!['GET','HEAD','OPTIONS'].includes(req.method)) {
    const expected = process.env.PUBLIC_ORIGIN || `http://${req.headers.host}`;
    if(req.headers.origin && req.headers.origin !== expected) return res.status(403).json({error:'访问来源不匹配，请检查 PUBLIC_ORIGIN 配置'});
    if(req.headers['x-workspace-request'] !== '1') return res.status(403).json({error:'请求无效'});
  }
  next();
});
app.use(express.json({limit:'128kb'}));
const digest = token => createHash('sha256').update(token).digest('hex');
function session(req) {
  const raw = /(?:^|;\s*)mw_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  if(!raw) return null;
  const now=Date.now();
  return db.prepare('SELECT s.*,d.name,d.color,g.username,g.expires AS guest_expires FROM sessions s JOIN devices d ON d.id=s.device_id LEFT JOIN guests g ON g.id=s.guest_id WHERE token=? AND s.expires>? AND (s.guest_id IS NULL OR (g.enabled=1 AND g.expires>? AND EXISTS(SELECT 1 FROM grants WHERE guest_id=g.id)))').get(digest(raw),now,now);
}
function auth(req,res,next) {
  req.user=session(req);
  if(!req.user) return res.status(401).json({error:'请先登录'});
  next();
}
const attempts = new Map();
app.get('/api/status',(req,res)=>{const current=session(req);res.json({initialized:!!db.prepare('SELECT id FROM account').get(),user:current?publicUser(current):null,maxFileMB:Number(process.env.MAX_FILE_MB||100)});});
app.post('/api/login',(req,res)=>{
  const key = req.socket.remoteAddress;
  const now=Date.now();
  const bucket=attempts.get(key);
  if(bucket && now-bucket.start<900000 && bucket.count>=10) return res.status(429).json({error:'尝试次数过多，请 15 分钟后重试'});
  const {password,deviceId,deviceName,username}=req.body;
  if(typeof password!=='string'||password.length<12||password.length>256) return res.status(400).json({error:'密码需要 12 至 256 个字符'});
  let account=db.prepare('SELECT * FROM account').get();
  if(!account){
    if(username&&String(username).trim().toLowerCase()!=='admin')return res.status(400).json({error:'首次设置时请将用户名留空'});
    // First setup is local only, before exposing the service to the internet.
    if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(key)) return res.status(403).json({error:'首次设置请在服务电脑上打开页面完成'});
    const salt=randomBytes(16).toString('hex');
    db.prepare('INSERT INTO account VALUES(1,?,?)').run(salt,scryptSync(password,salt,64).toString('hex'));
    db.prepare('INSERT INTO rooms(id,name,created) VALUES(?,?,?)').run(randomUUID(),'文件传输助手',now);
    account=db.prepare('SELECT * FROM account').get();
  }
  const guestLogin=typeof username==='string'&&username.trim()&&username.trim().toLowerCase()!=='admin';
  const guest=guestLogin?db.prepare('SELECT * FROM guests WHERE username=?').get(username.trim()):null;
  const credentials=guestLogin?guest:account;
  // Run the password derivation even for an unknown username.
  const candidate=scryptSync(password,credentials?.salt||account.salt,64);
  if(!credentials||!timingSafeEqual(candidate,Buffer.from(credentials.hash,'hex'))||(guestLogin&&(!guest.enabled||guest.expires<=now||!db.prepare('SELECT room_id FROM grants WHERE guest_id=? LIMIT 1').get(guest.id)))){
    attempts.set(key,{start:bucket&&now-bucket.start<900000?bucket.start:now,count:bucket&&now-bucket.start<900000?bucket.count+1:1});
    return res.status(401).json({error:'密码不正确'});
  }
  attempts.delete(key);
  let id=typeof deviceId==='string'&&/^[a-f0-9-]{36}$/.test(deviceId)?deviceId:randomUUID();
  const knownDevice=db.prepare('SELECT guest_id FROM devices WHERE id=?').get(id);
  if(knownDevice&&(knownDevice.guest_id||null)!==(guest?.id||null))id=randomUUID();
  const name=String(deviceName||'我的设备').trim().slice(0,60)||'我的设备';
  db.prepare('INSERT INTO devices(id,name,last_seen,guest_id,color) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen').run(id,name,now,guest?.id||null,guest?.color||colorFor(id));
  db.prepare('DELETE FROM sessions WHERE expires<=?').run(now);
  const token=randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token,device_id,expires,guest_id) VALUES(?,?,?,?)').run(digest(token),id,Math.min(now+30*86400000,guest?.expires||Infinity),guest?.id||null);
  res.setHeader('Set-Cookie',`mw_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${process.env.COOKIE_SECURE==='true'?'; Secure':''}`);
  res.json(publicUser({...db.prepare('SELECT * FROM devices WHERE id=?').get(id),device_id:id,username:guest?.username,guest_expires:guest?.expires}));
});
app.use('/api',auth);
const server=createServer(app);
const wss=new WebSocketServer({noServer:true,maxPayload:1024});
function broadcast(event){for(const ws of wss.clients) {
  const raw={headers:{cookie:`mw_session=${ws.rawToken}`}};const u=session(raw);
  if(!u){ws.close(4001,'Access expired');continue;}
  const roomId=event.message?.room_id||event.roomId;
  if(ws.readyState===1&&(!roomId||allowed(db,u,roomId)))ws.send(JSON.stringify(event));
}}
installCollaboration(app,db,broadcast);
server.on('upgrade',(req,socket,head)=>{
  const user=session(req);
  const expected=process.env.PUBLIC_ORIGIN||`http://${req.headers.host}`;
  if(req.url!=='/ws'||!user||req.headers.origin!==expected){socket.destroy();return;}
  wss.handleUpgrade(req,socket,head,ws=>{ws.token=user.token;ws.rawToken=/(?:^|;\s*)mw_session=([^;]+)/.exec(req.headers.cookie||'')?.[1];ws.alive=true;ws.on('pong',()=>ws.alive=true);ws.on('error',()=>{});wss.emit('connection',ws,req);});
});
const heartbeat=setInterval(()=>{for(const ws of wss.clients){if(!ws.alive){ws.terminate();continue;}if(!session({headers:{cookie:`mw_session=${ws.rawToken}`}})){ws.alive=false;ws.close(4001,'Access expired');continue;}ws.alive=false;ws.ping();}},25000);
heartbeat.unref();
app.post('/api/logout',(req,res)=>{db.prepare('DELETE FROM sessions WHERE token=?').run(req.user.token);res.setHeader('Set-Cookie','mw_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');res.json({ok:true});});
app.get('/api/rooms',(req,res)=>res.json(db.prepare(`SELECT r.*,(SELECT name FROM room_groups WHERE id=r.group_id) AS group_name,(SELECT MAX(created) FROM messages WHERE room_id=r.id) AS last_message_at,(SELECT body FROM messages WHERE room_id=r.id ORDER BY id DESC LIMIT 1) AS preview,(SELECT file_name FROM messages WHERE room_id=r.id ORDER BY id DESC LIMIT 1) AS file_preview,(SELECT MAX(id) FROM messages WHERE room_id=r.id) AS latest FROM rooms r WHERE ${scope(req.user,'x').replaceAll('x.room_id','r.id')} ORDER BY position,created`).all()));
app.post('/api/rooms',(req,res)=>{const name=String(req.body.name||'').trim().slice(0,60);if(!name)return res.status(400).json({error:'请输入群名称'});const room={id:randomUUID(),name,created:Date.now()};db.prepare('INSERT INTO rooms(id,name,created,position) VALUES(?,?,?,?)').run(room.id,room.name,room.created,Number(db.prepare('SELECT MAX(position) AS p FROM rooms').get().p||0)+1);broadcast({type:'rooms'});res.json(room);});
app.patch('/api/rooms/:id',(req,res)=>{
  const room=db.prepare('SELECT * FROM rooms WHERE id=?').get(req.params.id);if(!room)return res.status(404).json({error:'群不存在'});
  const name=req.body.name===undefined?room.name:String(req.body.name).trim().slice(0,60);if(!name)return res.status(400).json({error:'请输入群名称'});
  const group=req.body.groupId===undefined?room.group_id:req.body.groupId;
  if(group&&!db.prepare('SELECT id FROM room_groups WHERE id=?').get(group))return res.status(400).json({error:'分组不存在'});
  db.prepare('UPDATE rooms SET name=?,group_id=? WHERE id=?').run(name,group||null,room.id);broadcast({type:'rooms'});res.json({ok:true});
});
app.delete('/api/rooms/:id',(req,res)=>{
  const room=db.prepare('SELECT id FROM rooms WHERE id=?').get(req.params.id);
  if(!room)return res.status(404).json({error:'群不存在'});
  const files=db.prepare('SELECT file_key FROM messages WHERE room_id=? AND file_key IS NOT NULL').all(room.id);
  db.exec('BEGIN');
  try{db.prepare('DELETE FROM messages WHERE room_id=?').run(room.id);db.prepare('DELETE FROM rooms WHERE id=?').run(room.id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
  for(const file of files){try{unlinkSync(path.join(data,'files',file.file_key));}catch(e){if(e.code!=='ENOENT')console.error('Attachment cleanup failed:',e.code);}}
  broadcast({type:'room-deleted',roomId:room.id});broadcast({type:'rooms'});res.json({ok:true});
});
app.get('/api/search',(req,res)=>{
  const q=String(req.query.q||'').trim().slice(0,200),before=Number(req.query.before)||Number.MAX_SAFE_INTEGER;
  if(!q)return res.json([]);
  res.json(db.prepare(`SELECT m.*,r.name AS room_name FROM messages m JOIN rooms r ON r.id=m.room_id WHERE ${scope(req.user)} AND m.id<? AND (instr(lower(m.body),lower(?))>0 OR instr(lower(coalesce(m.file_name,'')),lower(?))>0) ORDER BY m.id DESC LIMIT 100`).all(before,q,q));
});
app.get('/api/files',(req,res)=>{
  const q=String(req.query.q||'').trim().slice(0,200),before=Number(req.query.before)||Number.MAX_SAFE_INTEGER;
  const room=String(req.query.room||''),ext=String(req.query.ext||'').toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,20);
  const from=Number(req.query.from)||0,to=Number(req.query.to)||Number.MAX_SAFE_INTEGER,min=Math.max(0,Number(req.query.min)||0),max=Number(req.query.max)||Number.MAX_SAFE_INTEGER;
  const where=`${scope(req.user)} AND m.file_key IS NOT NULL AND (?='' OR instr(lower(m.file_name),lower(?))>0) AND (?='' OR m.room_id=?) AND (?='' OR lower(m.file_name) LIKE ?) AND m.created>=? AND m.created<=? AND m.file_size>=? AND m.file_size<=?`;
  const params=[q,q,room,room,ext,'%.'+ext,from,to,min,max];
  const rows=db.prepare(`SELECT m.*,r.name AS room_name FROM messages m JOIN rooms r ON r.id=m.room_id WHERE ${where} AND m.id<? ORDER BY m.id DESC LIMIT 100`).all(...params,before);
  // Keep the legacy array response unless statistics are requested by the file viewer.
  if(req.query.stats==='1'){const stats=db.prepare(`SELECT COUNT(*) AS count,coalesce(SUM(m.file_size),0) AS bytes FROM messages m WHERE ${where}`).get(...params);return res.json({rows,...stats});}
  res.json(rows);
});
app.get('/api/messages/:id/context',(req,res)=>{
  const message=db.prepare('SELECT * FROM messages WHERE id=?').get(req.params.id);
  if(!message)return res.status(404).json({error:'消息已被删除'});
  const previous=db.prepare('SELECT * FROM messages WHERE room_id=? AND id<? ORDER BY id DESC LIMIT 30').all(message.room_id,message.id).reverse();
  const following=db.prepare('SELECT * FROM messages WHERE room_id=? AND id>? ORDER BY id ASC LIMIT 30').all(message.room_id,message.id);
  const messages=[...previous,message,...following];
  res.json({roomId:message.room_id,messages,hasBefore:!!db.prepare('SELECT id FROM messages WHERE room_id=? AND id<? LIMIT 1').get(message.room_id,messages[0].id),hasAfter:!!db.prepare('SELECT id FROM messages WHERE room_id=? AND id>? LIMIT 1').get(message.room_id,messages.at(-1).id)});
});
function requireRoom(req,res,next){if(!db.prepare('SELECT id FROM rooms WHERE id=?').get(req.params.id))return res.status(404).json({error:'群不存在'});next();}
app.get('/api/rooms/:id/messages',requireRoom,(req,res)=>{
  const before=Number(req.query.before)||Number.MAX_SAFE_INTEGER;
  const after=Number(req.query.after)||0;
  const query=String(req.query.q||'').slice(0,200);
  const rows=db.prepare(`SELECT * FROM messages WHERE room_id=? AND id<? AND id>? AND (?='' OR instr(lower(body),lower(?))>0 OR instr(lower(coalesce(file_name,'')),lower(?))>0) ORDER BY id ${after?'ASC':'DESC'} LIMIT 100`).all(req.params.id,before,after,query,query,query);
  res.json(after?rows:rows.reverse());
});
function insertMessage(req,file){
  const current=session(req);
  if(!current)throw Object.assign(new Error('请先登录'),{status:401});
  if(!allowed(db,current,req.params.id))throw Object.assign(new Error('没有此项目群的权限'),{status:403});
  req.user=current;
  if(!db.prepare('SELECT id FROM rooms WHERE id=?').get(req.params.id))throw Object.assign(new Error('项目群已被删除'),{status:404});
  const clientId=String(req.body.clientId||'');
  if(!/^[a-f0-9-]{36}$/.test(clientId)) throw Object.assign(new Error('消息标识无效'),{status:400});
  const existing=db.prepare('SELECT * FROM messages WHERE client_id=?').get(clientId);
  if(existing){if(file)unlinkSync(file.path);if(existing.room_id!==req.params.id)throw Object.assign(new Error('消息标识冲突'),{status:409});return existing;}
  const body=typeof req.body.body==='string'?req.body.body.trim():'';
  if(!file&&(!body||body.length>20000))throw Object.assign(new Error('消息需要 1 至 20000 个字符'),{status:400});
  const result=db.prepare('INSERT INTO messages(room_id,device_id,device_name,body,file_key,file_name,file_size,client_id,created,guest_id,sender_color,sender_username) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(req.params.id,req.user.device_id,req.user.name,body.slice(0,20000),file?.filename||null,file?Buffer.from(file.originalname,'latin1').toString('utf8'):null,file?.size??null,clientId,Date.now(),req.user.guest_id||null,req.user.color,req.user.username||null);
  const message=db.prepare('SELECT * FROM messages WHERE id=?').get(result.lastInsertRowid);
  broadcast({type:'message',message});return message;
}
app.post('/api/rooms/:id/messages',requireRoom,(req,res,next)=>{try{res.json(insertMessage(req));}catch(e){next(e);}});
const upload=multer({storage:multer.diskStorage({destination:path.join(data,'files'),filename:(req,file,cb)=>cb(null,randomUUID())}),limits:{fileSize:Number(process.env.MAX_FILE_MB||100)*1024*1024,files:1,fields:2,fieldSize:100000}});
app.post('/api/rooms/:id/files',requireRoom,upload.single('file'),(req,res,next)=>{try{if(!req.file)throw Object.assign(new Error('请选择文件'),{status:400});res.json(insertMessage(req,req.file));}catch(e){if(req.file&&existsSync(req.file.path))unlinkSync(req.file.path);next(e);}});
app.get('/api/files/:id',(req,res)=>{const message=db.prepare('SELECT * FROM messages WHERE id=? AND file_key IS NOT NULL').get(req.params.id);if(!message)return res.status(404).json({error:'文件不存在'});res.download(path.join(data,'files',message.file_key),message.file_name);});
const inlineTypes={'.pdf':'application/pdf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp'};
const textTypes=new Set(['.txt','.md','.csv','.json','.xml','.html','.css','.js','.ts','.py','.yaml','.yml','.toml','.ini','.log','.sql']);
async function readPrefix(filename,limit){const handle=await open(filename,'r');try{const buffer=Buffer.alloc(limit);const {bytesRead}=await handle.read(buffer,0,limit,0);return buffer.subarray(0,bytesRead);}finally{await handle.close();}}
function officePreview(filename,ext){
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./preview-worker.js',import.meta.url),{workerData:{filename,ext},resourceLimits:{maxOldGenerationSizeMb:128}});
    const timer=setTimeout(()=>{worker.terminate();reject(new Error('预览处理超时，请下载后打开'));},10000);
    const finish=(error,result)=>{clearTimeout(timer);worker.terminate();error?reject(error):resolve(result);};
    worker.once('message',result=>finish(result.error?new Error(result.error):null,result));worker.once('error',error=>finish(error));worker.once('exit',code=>{if(code!==0)finish(new Error('文件无法预览，请下载后打开'));});
  });
}
app.get('/api/files/:id/preview',async(req,res,next)=>{
  try{
    const message=db.prepare('SELECT * FROM messages WHERE id=? AND file_key IS NOT NULL').get(req.params.id);
    if(!message)return res.status(404).json({error:'文件不存在'});
    const ext=path.extname(message.file_name).toLowerCase(),filename=path.join(data,'files',message.file_key);
    const result={id:message.id,name:message.file_name,size:message.file_size,roomId:message.room_id};
    if(inlineTypes[ext])return res.json({...result,kind:ext==='.pdf'?'pdf':'image',url:`/api/files/${message.id}/content`});
    if(textTypes.has(ext)){const buffer=await readPrefix(filename,1024*1024+1);return res.json({...result,kind:'text',text:buffer.subarray(0,1024*1024).toString('utf8'),truncated:buffer.length>1024*1024});}
    if(['.docx','.xlsx'].includes(ext)){
      if(message.file_size>10*1024*1024)return res.json({...result,kind:'unsupported',reason:'Office 文件超过 10 MB，请下载后打开'});
      try{return res.json({...result,...await officePreview(filename,ext)});}catch{return res.json({...result,kind:'unsupported',reason:'该文档无法预览，可能已加密、损坏或超出处理限制，请下载后打开'});}
    }
    res.json({...result,kind:'unsupported',reason:'该格式暂不支持在线预览，请下载后用本地应用打开'});
  }catch(e){next(e);}
});
app.get('/api/files/:id/content',async(req,res,next)=>{
  try{
    const message=db.prepare('SELECT * FROM messages WHERE id=? AND file_key IS NOT NULL').get(req.params.id);
    if(!message)return res.status(404).json({error:'文件不存在'});
    const ext=path.extname(message.file_name).toLowerCase(),type=inlineTypes[ext];
    if(!type)return res.status(415).json({error:'此格式不允许直接内嵌'});
    const filename=path.join(data,'files',message.file_key),head=await readPrefix(filename,16);
    const valid=ext==='.pdf'?head.subarray(0,5).toString()==='%PDF-':ext==='.png'?head.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):['.jpg','.jpeg'].includes(ext)?head[0]===255&&head[1]===216&&head[2]===255:ext==='.gif'?/^GIF8[79]a/.test(head.toString('ascii')):head.subarray(0,4).toString()==='RIFF'&&head.subarray(8,12).toString()==='WEBP';
    if(!valid)return res.status(415).json({error:'文件内容与格式不匹配，请下载后打开'});
    res.setHeader('Content-Type',type);res.setHeader('Content-Disposition',`inline; filename*=UTF-8''${encodeURIComponent(message.file_name)}`);
    res.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'self'");
    res.sendFile(filename);
  }catch(e){next(e);}
});
app.delete('/api/messages/:id',(req,res)=>{const message=db.prepare('SELECT * FROM messages WHERE id=?').get(req.params.id);if(!message)return res.status(404).json({error:'消息不存在'});db.prepare('DELETE FROM messages WHERE id=?').run(message.id);if(message.file_key&&existsSync(path.join(data,'files',message.file_key)))unlinkSync(path.join(data,'files',message.file_key));broadcast({type:'deleted',id:message.id,roomId:message.room_id});res.json({ok:true});});
app.get('/api/devices',(req,res)=>res.json(db.prepare('SELECT id,name,last_seen,color,guest_id FROM devices WHERE id IN (SELECT device_id FROM sessions WHERE expires>?)').all(Date.now())));
app.patch('/api/device',(req,res)=>{const name=String(req.body.name||req.user.name).trim().slice(0,60);if(!name)return res.status(400).json({error:'请输入设备名称'});const color=/^#[0-9a-f]{6}$/i.test(req.body.color||'')?req.body.color:req.user.color;db.prepare('UPDATE devices SET name=?,color=?,last_seen=? WHERE id=?').run(name,color,Date.now(),req.user.device_id);res.json({name,color});});
app.delete('/api/devices/:id/sessions',(req,res)=>{db.prepare('DELETE FROM sessions WHERE device_id=?').run(req.params.id);res.json({ok:true});});
app.use(express.static(path.join(root,'public'),{etag:true}));
app.use('/vendor/pdfjs',express.static(path.join(root,'node_modules/pdfjs-dist/build')));
app.use('/vendor/pdfjs-fonts',express.static(path.join(root,'node_modules/pdfjs-dist/standard_fonts')));
app.use('/vendor/pdfjs-cmaps',express.static(path.join(root,'node_modules/pdfjs-dist/cmaps')));
app.use((err,req,res,next)=>{if(res.headersSent)return next(err);res.status(err.code==='LIMIT_FILE_SIZE'?413:err.status||400).json({error:err.code==='LIMIT_FILE_SIZE'?'文件超过上传大小限制':err.message||'操作失败'});});
server.listen(Number(process.env.PORT||3000),process.env.HOST||'127.0.0.1',()=>console.log(`MultiWorks: http://${process.env.HOST||'127.0.0.1'}:${process.env.PORT||3000}`));
function shutdown(){clearInterval(heartbeat);for(const ws of wss.clients)ws.terminate();server.close(()=>{db.close();process.exit(0);});}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
