import { randomUUID, randomBytes, scryptSync } from 'node:crypto';

export function migrate(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
  const add=(table,name,type)=>{if(!db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name===name)){db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);return true;}return false;};
  db.exec(`CREATE TABLE IF NOT EXISTS guests(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,salt TEXT NOT NULL,hash TEXT NOT NULL,expires INTEGER NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,color TEXT NOT NULL,created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS grants(guest_id TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,PRIMARY KEY(guest_id,room_id));
  CREATE TABLE IF NOT EXISTS room_groups(id TEXT PRIMARY KEY,name TEXT NOT NULL,position INTEGER NOT NULL DEFAULT 0);`);
  add('sessions','guest_id','TEXT');add('devices','guest_id','TEXT');const newColors=add('devices','color',"TEXT NOT NULL DEFAULT '#36a18b'");
  add('rooms','group_id','TEXT');add('rooms','position','INTEGER NOT NULL DEFAULT 0');
  add('messages','guest_id','TEXT');const newMessageColors=add('messages','sender_color',"TEXT NOT NULL DEFAULT '#36a18b'");add('messages','sender_username','TEXT');
  if(newColors)for(const device of db.prepare('SELECT id FROM devices').all())db.prepare('UPDATE devices SET color=? WHERE id=?').run(colorFor(device.id),device.id);
  if(newMessageColors)for(const device of db.prepare('SELECT DISTINCT device_id FROM messages').all())db.prepare('UPDATE messages SET sender_color=? WHERE device_id=?').run(colorFor(device.device_id),device.device_id);
  db.exec('UPDATE messages SET file_size=0 WHERE file_key IS NOT NULL AND file_size IS NULL;');
  db.exec('CREATE INDEX IF NOT EXISTS messages_room_created ON messages(room_id,created);');
  db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}
export function allowed(db,user,roomId){return !user.guest_id||!!db.prepare('SELECT room_id FROM grants WHERE guest_id=? AND room_id=?').get(user.guest_id,roomId);}
export function scope(user,alias='m'){return user.guest_id?`${alias}.room_id IN (SELECT room_id FROM grants WHERE guest_id='${user.guest_id}')`:'1=1';}
export function publicUser(user){return {id:user.device_id,name:user.name,color:user.color,guest:!!user.guest_id,username:user.username||null,expires:user.guest_expires||null};}

export function installCollaboration(app,db,broadcast) {
  app.use('/api',(req,res,next)=>{
    const u=req.user;if(!u)return next();
    let route;try{route=decodeURIComponent(req.path).replace(/\/+$/,'')||'/';}catch{return res.status(400).json({error:'请求无效'});}
    if(u.guest_id){
      if(/^\/(guests|groups|devices)(\/|$)/i.test(route)||route.toLowerCase()==='/rooms/order'||(route.toLowerCase()==='/rooms'&&req.method!=='GET')||(/^\/rooms\/[^/]+$/i.test(route)&&req.method!=='GET'))return res.status(403).json({error:'需要管理员权限'});
    }
    const room=/^\/rooms\/([^/]+)/i.exec(route);
    if(room&&room[1]!=='order'&&!allowed(db,u,room[1]))return res.status(403).json({error:'没有此项目群的权限'});
    const item=/^\/(files|messages)\/([^/]+)/i.exec(route);
    if(item){const m=db.prepare('SELECT room_id,device_id FROM messages WHERE id=?').get(item[2]);if(m&&!allowed(db,u,m.room_id))return res.status(403).json({error:'没有此项目群的权限'});if(m&&u.guest_id&&req.method==='DELETE'&&m.device_id!==u.device_id)return res.status(403).json({error:'只能删除自己的消息'});}
    next();
  });
  const changed=()=>broadcast({type:'rooms'});
  app.get('/api/groups',(req,res)=>res.json(db.prepare('SELECT * FROM room_groups ORDER BY position,id').all()));
  app.post('/api/groups',(req,res)=>{const name=String(req.body.name||'').trim().slice(0,60);if(!name)return res.status(400).json({error:'请输入分组名称'});const group={id:randomUUID(),name};db.prepare('INSERT INTO room_groups(id,name) VALUES(?,?)').run(group.id,name);changed();res.json(group);});
  app.patch('/api/groups/:id',(req,res)=>{const name=String(req.body.name||'').trim().slice(0,60);if(!name)return res.status(400).json({error:'请输入分组名称'});db.prepare('UPDATE room_groups SET name=? WHERE id=?').run(name,req.params.id);changed();res.json({ok:true});});
  app.delete('/api/groups/:id',(req,res)=>{db.exec('BEGIN');try{db.prepare('UPDATE rooms SET group_id=NULL WHERE group_id=?').run(req.params.id);db.prepare('DELETE FROM room_groups WHERE id=?').run(req.params.id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}changed();res.json({ok:true});});
  app.post('/api/rooms/order',(req,res)=>{const ids=req.body.ids;if(!Array.isArray(ids)||ids.length>10000||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!db.prepare('SELECT id FROM rooms WHERE id=?').get(id)))return res.status(400).json({error:'排序无效'});db.exec('BEGIN');try{ids.forEach((id,index)=>db.prepare('UPDATE rooms SET position=? WHERE id=?').run(index,id));db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}changed();res.json({ok:true});});
  app.get('/api/guests',(req,res)=>res.json(db.prepare('SELECT id,username,expires,enabled,color,created FROM guests ORDER BY created DESC').all().map(g=>({...g,rooms:db.prepare('SELECT room_id FROM grants WHERE guest_id=?').all(g.id).map(r=>r.room_id)}))));
  function writeGuest(req,res,existing){
    const b=req.body,username=String(b.username||existing?.username||'').trim(),days=Number(b.days);
    if(!/^[\p{L}\p{N}_.@-]{1,60}$/u.test(username)||username.toLowerCase()==='admin')return res.status(400).json({error:'用户名需要 1–60 个字母、数字或 _ . @ -，不能使用 admin'});
    if(!existing||b.password){if(typeof b.password!=='string'||b.password.length<12||b.password.length>256)return res.status(400).json({error:'密码需要 12 至 256 个字符'});}
    const roomIds=b.rooms??(existing?db.prepare('SELECT room_id FROM grants WHERE guest_id=?').all(existing.id).map(r=>r.room_id):[]);
    if(!Array.isArray(roomIds)||roomIds.length>10000||roomIds.some(id=>typeof id!=='string'||!db.prepare('SELECT id FROM rooms WHERE id=?').get(id)))return res.status(400).json({error:'项目群授权无效'});
    if((!existing||b.days!==undefined)&&![1,3,5,7,30].includes(days))return res.status(400).json({error:'有效期只能为 1、3、5、7、30 天'});
    const id=existing?.id||randomUUID(),salt=b.password?randomBytes(16).toString('hex'):existing.salt,hash=b.password?scryptSync(b.password,salt,64).toString('hex'):existing.hash;
    const color=/^#[0-9a-f]{6}$/i.test(b.color||'')?b.color:existing?.color||colorFor(id);
    db.exec('BEGIN');try{
      db.prepare('INSERT INTO guests VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username,salt=excluded.salt,hash=excluded.hash,expires=excluded.expires,enabled=excluded.enabled,color=excluded.color').run(id,username,salt,hash,b.days!==undefined?Date.now()+days*86400000:existing?.expires||Date.now()+days*86400000,b.enabled===false?0:existing&&!b.days?existing.enabled:1,color,existing?.created||Date.now());
      db.prepare('DELETE FROM grants WHERE guest_id=?').run(id);for(const room of new Set(roomIds))db.prepare('INSERT INTO grants VALUES(?,?)').run(id,room);
      db.prepare('DELETE FROM sessions WHERE guest_id=?').run(id);db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');if(String(e.message).includes('UNIQUE'))return res.status(409).json({error:'用户名已存在'});throw e;}
    broadcast({type:'access-changed'});res.json({id,username});
  }
  app.post('/api/guests',(req,res)=>writeGuest(req,res));
  app.patch('/api/guests/:id',(req,res)=>{const g=db.prepare('SELECT * FROM guests WHERE id=?').get(req.params.id);if(!g)return res.status(404).json({error:'账户不存在'});writeGuest(req,res,g);});
  app.delete('/api/guests/:id',(req,res)=>{db.exec('BEGIN');try{db.prepare('DELETE FROM sessions WHERE guest_id=?').run(req.params.id);db.prepare('DELETE FROM guests WHERE id=?').run(req.params.id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}broadcast({type:'access-changed'});res.json({ok:true});});
}
export function colorFor(id){const palette=['#36a18b','#637cdd','#bf6db4','#d08036','#3599b0','#ba655d','#819638'];return palette[[...id].reduce((n,c)=>n+c.charCodeAt(0),0)%palette.length];}
