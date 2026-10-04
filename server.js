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
const app = express();
app.disable('x-powered-by');
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
  return db.prepare('SELECT s.*,d.name FROM sessions s JOIN devices d ON d.id=s.device_id WHERE token=? AND expires>?').get(digest(raw),Date.now());
}
function auth(req,res,next) {
  req.user=session(req);
  if(!req.user) return res.status(401).json({error:'请先登录'});
  next();
}
const attempts = new Map();
app.get('/api/status',(req,res)=>res.json({initialized:!!db.prepare('SELECT id FROM account').get(),user:session(req)?{id:session(req).device_id,name:session(req).name}:null,maxFileMB:Number(process.env.MAX_FILE_MB||100)}));
app.post('/api/login',(req,res)=>{
  const key = req.socket.remoteAddress;
  const now=Date.now();
  const bucket=attempts.get(key);
  if(bucket && now-bucket.start<900000 && bucket.count>=10) return res.status(429).json({error:'尝试次数过多，请 15 分钟后重试'});
  const {password,deviceId,deviceName}=req.body;
  if(typeof password!=='string'||password.length<12||password.length>256) return res.status(400).json({error:'密码需要 12 至 256 个字符'});
  let account=db.prepare('SELECT * FROM account').get();
  if(!account){
    // First setup is local only, before exposing the service to the internet.
    if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(key)) return res.status(403).json({error:'首次设置请在服务电脑上打开页面完成'});
    const salt=randomBytes(16).toString('hex');
    db.prepare('INSERT INTO account VALUES(1,?,?)').run(salt,scryptSync(password,salt,64).toString('hex'));
    db.prepare('INSERT INTO rooms VALUES(?,?,?)').run(randomUUID(),'文件传输助手',now);
    account=db.prepare('SELECT * FROM account').get();
  }
  if(!timingSafeEqual(scryptSync(password,account.salt,64),Buffer.from(account.hash,'hex'))){
    attempts.set(key,{start:bucket&&now-bucket.start<900000?bucket.start:now,count:bucket&&now-bucket.start<900000?bucket.count+1:1});
    return res.status(401).json({error:'密码不正确'});
  }
  attempts.delete(key);
  const id=typeof deviceId==='string'&&/^[a-f0-9-]{36}$/.test(deviceId)?deviceId:randomUUID();
  const name=String(deviceName||'我的设备').trim().slice(0,60)||'我的设备';
  db.prepare('INSERT INTO devices VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen').run(id,name,now);
  db.prepare('DELETE FROM sessions WHERE expires<=?').run(now);
  const token=randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token),id,now+30*86400000);
  res.setHeader('Set-Cookie',`mw_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${process.env.COOKIE_SECURE==='true'?'; Secure':''}`);
  res.json({id,name:db.prepare('SELECT name FROM devices WHERE id=?').get(id).name});
});
app.use('/api',auth);
const server=createServer(app);
const wss=new WebSocketServer({noServer:true,maxPayload:1024});
function broadcast(event){for(const ws of wss.clients) if(ws.readyState===1 && db.prepare('SELECT token FROM sessions WHERE token=? AND expires>?').get(ws.token,Date.now())) ws.send(JSON.stringify(event));}
server.on('upgrade',(req,socket,head)=>{
  const user=session(req);
  const expected=process.env.PUBLIC_ORIGIN||`http://${req.headers.host}`;
  if(req.url!=='/ws'||!user||req.headers.origin!==expected){socket.destroy();return;}
  wss.handleUpgrade(req,socket,head,ws=>{ws.token=user.token;ws.alive=true;ws.on('pong',()=>ws.alive=true);ws.on('error',()=>{});wss.emit('connection',ws,req);});
});
const heartbeat=setInterval(()=>{for(const ws of wss.clients){if(!ws.alive||!db.prepare('SELECT token FROM sessions WHERE token=? AND expires>?').get(ws.token,Date.now())) {ws.terminate();continue;}ws.alive=false;ws.ping();}},25000);
heartbeat.unref();
app.post('/api/logout',(req,res)=>{db.prepare('DELETE FROM sessions WHERE token=?').run(req.user.token);res.setHeader('Set-Cookie','mw_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');res.json({ok:true});});
app.get('/api/rooms',(req,res)=>res.json(db.prepare(`SELECT r.*,(SELECT body FROM messages WHERE room_id=r.id ORDER BY id DESC LIMIT 1) AS preview,(SELECT file_name FROM messages WHERE room_id=r.id ORDER BY id DESC LIMIT 1) AS file_preview,(SELECT MAX(id) FROM messages WHERE room_id=r.id) AS latest FROM rooms r ORDER BY created`).all()));
app.post('/api/rooms',(req,res)=>{const name=String(req.body.name||'').trim().slice(0,60);if(!name)return res.status(400).json({error:'请输入群名称'});const room={id:randomUUID(),name,created:Date.now()};db.prepare('INSERT INTO rooms VALUES(?,?,?)').run(room.id,room.name,room.created);broadcast({type:'rooms'});res.json(room);});
app.patch('/api/rooms/:id',(req,res)=>{const name=String(req.body.name||'').trim().slice(0,60);if(!name)return res.status(400).json({error:'请输入群名称'});const result=db.prepare('UPDATE rooms SET name=? WHERE id=?').run(name,req.params.id);if(!result.changes)return res.status(404).json({error:'群不存在'});broadcast({type:'rooms'});res.json({ok:true});});
app.delete('/api/rooms/:id',(req,res)=>{
  const room=db.prepare('SELECT id FROM rooms WHERE id=?').get(req.params.id);
  if(!room)return res.status(404).json({error:'群不存在'});
  const files=db.prepare('SELECT file_key FROM messages WHERE room_id=? AND file_key IS NOT NULL').all(room.id);
  db.exec('BEGIN');
  try{db.prepare('DELETE FROM messages WHERE room_id=?').run(room.id);db.prepare('DELETE FROM rooms WHERE id=?').run(room.id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
  for(const file of files){try{unlinkSync(path.join(data,'files',file.file_key));}catch(e){if(e.code!=='ENOENT')console.error('Attachment cleanup failed:',e.code);}}
  broadcast({type:'room-deleted',roomId:room.id});res.json({ok:true});
});
app.get('/api/search',(req,res)=>{
  const q=String(req.query.q||'').trim().slice(0,200),before=Number(req.query.before)||Number.MAX_SAFE_INTEGER;
  if(!q)return res.json([]);
  res.json(db.prepare(`SELECT m.*,r.name AS room_name FROM messages m JOIN rooms r ON r.id=m.room_id WHERE m.id<? AND (instr(lower(m.body),lower(?))>0 OR instr(lower(coalesce(m.file_name,'')),lower(?))>0) ORDER BY m.id DESC LIMIT 100`).all(before,q,q));
});
app.get('/api/files',(req,res)=>{
  const q=String(req.query.q||'').trim().slice(0,200),before=Number(req.query.before)||Number.MAX_SAFE_INTEGER;
  res.json(db.prepare(`SELECT m.*,r.name AS room_name FROM messages m JOIN rooms r ON r.id=m.room_id WHERE m.file_key IS NOT NULL AND m.id<? AND (?='' OR instr(lower(m.file_name),lower(?))>0) ORDER BY m.id DESC LIMIT 100`).all(before,q,q));
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
  if(!db.prepare('SELECT id FROM rooms WHERE id=?').get(req.params.id))throw Object.assign(new Error('项目群已被删除'),{status:404});
  const clientId=String(req.body.clientId||'');
  if(!/^[a-f0-9-]{36}$/.test(clientId)) throw Object.assign(new Error('消息标识无效'),{status:400});
  const existing=db.prepare('SELECT * FROM messages WHERE client_id=?').get(clientId);
  if(existing){if(file)unlinkSync(file.path);if(existing.room_id!==req.params.id)throw Object.assign(new Error('消息标识冲突'),{status:409});return existing;}
  const body=typeof req.body.body==='string'?req.body.body.trim():'';
  if(!file&&(!body||body.length>20000))throw Object.assign(new Error('消息需要 1 至 20000 个字符'),{status:400});
  const result=db.prepare('INSERT INTO messages(room_id,device_id,device_name,body,file_key,file_name,file_size,client_id,created) VALUES(?,?,?,?,?,?,?,?,?)').run(req.params.id,req.user.device_id,req.user.name,body.slice(0,20000),file?.filename||null,file?Buffer.from(file.originalname,'latin1').toString('utf8'):null,file?.size||null,clientId,Date.now());
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
app.get('/api/devices',(req,res)=>res.json(db.prepare('SELECT id,name,last_seen FROM devices WHERE id IN (SELECT device_id FROM sessions WHERE expires>?)').all(Date.now())));
app.patch('/api/device',(req,res)=>{const name=String(req.body.name||'').trim().slice(0,60);if(!name)return res.status(400).json({error:'请输入设备名称'});db.prepare('UPDATE devices SET name=?,last_seen=? WHERE id=?').run(name,Date.now(),req.user.device_id);res.json({name});});
app.delete('/api/devices/:id/sessions',(req,res)=>{db.prepare('DELETE FROM sessions WHERE device_id=?').run(req.params.id);res.json({ok:true});});
app.use(express.static(path.join(root,'public'),{etag:true}));
app.use('/vendor/pdfjs',express.static(path.join(root,'node_modules/pdfjs-dist/build')));
app.use('/vendor/pdfjs-fonts',express.static(path.join(root,'node_modules/pdfjs-dist/standard_fonts')));
app.use('/vendor/pdfjs-cmaps',express.static(path.join(root,'node_modules/pdfjs-dist/cmaps')));
app.use((err,req,res,next)=>{if(res.headersSent)return next(err);res.status(err.code==='LIMIT_FILE_SIZE'?413:err.status||400).json({error:err.code==='LIMIT_FILE_SIZE'?'文件超过上传大小限制':err.message||'操作失败'});});
server.listen(Number(process.env.PORT||3000),process.env.HOST||'127.0.0.1',()=>console.log(`MultiWorks: http://${process.env.HOST||'127.0.0.1'}:${process.env.PORT||3000}`));
function shutdown(){clearInterval(heartbeat);for(const ws of wss.clients)ws.terminate();server.close(()=>{db.close();process.exit(0);});}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
