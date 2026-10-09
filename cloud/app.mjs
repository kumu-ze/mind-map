import express from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transaction } from './db.mjs';
import { token, digest, hashPassword, verifyPassword, title, cleanMap, emptyMap, fail } from './security.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = value => { if (!UUID.test(value || '')) fail(404, '内容不存在'); return value; };
const publicUser = user => ({ id: user.id, username: user.username, displayName: user.display_name, role: user.role });
function equal(a,b) { return typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b)); }
export function createApp({ pool, publicUrl, secureCookies = true, staticDir = path.join(here,'public'), editorDir = path.join(here,'editor') }) {
 const app = express(), base = '/mindmap', api = express.Router(), origin = new URL(publicUrl).origin;
 app.disable('x-powered-by'); app.set('trust proxy', 1);
 app.use(base, (req,res,next) => {
  res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'SAMEORIGIN',
   'Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'"});
  next();
 });
 app.use(base + '/api', express.json({limit:'12mb', strict:true}), api);
 api.use((req,res,next) => {
  if(req.body === undefined) req.body = {};
  if(req.body === null || Array.isArray(req.body)) return next(Object.assign(new Error('请求格式无效'),{status:400}));
  if (!['GET','HEAD','OPTIONS'].includes(req.method) && req.get('origin') !== origin) return next(Object.assign(new Error('请求来源无效，请刷新后重试'), {status:403}));
  next();
 });
 const authAttempts = new Map();
 function rate(req,res,next) {
  const now=Date.now(), key=req.ip, old=authAttempts.get(key);
  const entry=old && old.until>now ? old : {until:now+15*60*1000,count:0};
  entry.count++; authAttempts.set(key,entry);
  if (authAttempts.size>10000) for (const [k,v] of authAttempts) if(v.until<now) authAttempts.delete(k);
  if(entry.count>30) { res.set('Retry-After','900'); return next(Object.assign(new Error('尝试过于频繁，请稍后重试'),{status:429})); }
  next();
 }
 const cookieOptions = { httpOnly:true, secure:secureCookies, sameSite:'strict', path:base+'/', maxAge:7*86400000 };
 async function createSession(res,user,db=pool) {
  const value=token(), csrf=token();
  await db.query("INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '7 days')",[digest(value),user.id,csrf]);
  res.cookie('konon_mindmap',value,cookieOptions);
  return {user:publicUser(user),csrfToken:csrf};
 }
 async function auth(req,res,next) {
  const cookie=(req.get('cookie') || '').split(';').map(p=>p.trim()).find(p=>p.startsWith('konon_mindmap='));
  const value=cookie?.slice('konon_mindmap='.length);
  if(!value || value.length>100) fail(401,'请先登录');
  const result=await pool.query('SELECT u.*,s.csrf,s.token_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()',[digest(value)]);
  if(!result.rowCount) fail(401,'登录已过期，请重新登录');
  req.user=result.rows[0]; req.sessionHash=req.user.token_hash;
  if(!['GET','HEAD'].includes(req.method) && !equal(req.get('x-csrf-token'),req.user.csrf)) fail(403,'会话校验失败，请刷新后重试');
  next();
 }
 const admin=(req,res,next)=>{ if(req.user.role!=='admin') fail(403,'仅管理员可操作'); next(); };
 async function ownedMap(db,mapId,userId,{deleted=false,lock=false}={}) {
  const result=await db.query('SELECT * FROM maps WHERE id=$1 AND owner_id=$2'+(deleted?'':' AND deleted_at IS NULL')+(lock?' FOR UPDATE':''),[id(mapId),userId]);
  if(!result.rowCount) fail(404,'导图不存在或无权访问');
  return result.rows[0];
 }
 async function checkFolder(db,folderId,userId) {
  if(!folderId) return null;
  const result=await db.query('SELECT id FROM folders WHERE id=$1 AND owner_id=$2',[id(folderId),userId]);
  if(!result.rowCount) fail(404,'文件夹不存在'); return folderId;
 }
 async function remember(db,map) {
  await db.query('INSERT INTO revisions(id,map_id,version,title,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT(map_id,version) DO NOTHING',[randomUUID(),map.id,map.version,map.title,JSON.stringify(map.data)]);
  await db.query('DELETE FROM revisions WHERE map_id=$1 AND id NOT IN (SELECT id FROM revisions WHERE map_id=$1 ORDER BY version DESC LIMIT 20)',[map.id]);
 }
 api.get('/health',async(req,res)=>{ await pool.query('SELECT 1'); res.json({ok:true}); });
 api.post('/auth/login',rate,async(req,res)=>{
  const username=String(req.body.username||'').trim().toLowerCase();
  const result=await pool.query('SELECT * FROM users WHERE username=$1',[username]);
  const user=result.rows[0];
  // Same expensive verification for unknown users limits account timing disclosure.
  const dummy='00000000000000000000000000000000:'+ '0'.repeat(128);
  if(!await verifyPassword(req.body.password,user?.password_hash||dummy) || !user) fail(401,'用户名或密码不正确');
  res.json(await createSession(res,user));
 });
 api.post('/auth/register',rate,async(req,res)=>{
  const username=String(req.body.username||'').trim().toLowerCase();
  if(!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(username)) fail(400,'用户名需为 3–32 位字母、数字、下划线或短横线');
  const displayName=title(req.body.displayName,username), passwordHash=await hashPassword(req.body.password);
  const invite=String(req.body.invite||'');
  if(invite.length<20||invite.length>100) fail(400,'邀请码无效');
  const user=await transaction(pool,async db=>{
   const result=await db.query('SELECT * FROM invites WHERE token_hash=$1 AND expires_at>now() AND used_by IS NULL FOR UPDATE',[digest(invite)]);
   if(!result.rowCount) fail(400,'邀请码无效、已使用或已过期');
   const record={id:randomUUID(),username,display_name:displayName,role:result.rows[0].role};
   await db.query('INSERT INTO users(id,username,display_name,password_hash,role) VALUES($1,$2,$3,$4,$5)',[record.id,username,displayName,passwordHash,record.role]);
   await db.query('UPDATE invites SET used_by=$1 WHERE id=$2',[record.id,result.rows[0].id]);
   return record;
  });
  res.status(201).json(await createSession(res,user));
 });
 api.get('/public/shares/:token',async(req,res)=>{
  if(!/^[a-zA-Z0-9_-]{43}$/.test(req.params.token)) fail(404,'分享不存在或已失效');
  const result=await pool.query('SELECT m.id,m.title,m.data,m.updated_at,s.expires_at FROM shares s JOIN maps m ON m.id=s.map_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND m.deleted_at IS NULL',[digest(req.params.token)]);
  if(!result.rowCount) fail(404,'分享不存在或已失效');
  res.json({map:result.rows[0],readonly:true});
 });
 api.use(auth);
 api.post('/sanitize',(req,res)=>res.json({data:cleanMap(req.body.data)}));
 api.get('/session',(req,res)=>res.json({user:publicUser(req.user),csrfToken:req.user.csrf}));
 api.post('/auth/logout',async(req,res)=>{
  await pool.query('DELETE FROM sessions WHERE token_hash=$1',[req.sessionHash]);
  res.clearCookie('konon_mindmap',{...cookieOptions,maxAge:undefined}); res.json({ok:true});
 });
 api.post('/auth/password',async(req,res)=>{
  if(!await verifyPassword(req.body.currentPassword,req.user.password_hash)) fail(400,'当前密码不正确');
  const hashed=await hashPassword(req.body.password);
  await transaction(pool,async db=>{
   await db.query('UPDATE users SET password_hash=$1 WHERE id=$2',[hashed,req.user.id]);
   await db.query('DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2',[req.user.id,req.sessionHash]);
  }); res.json({ok:true});
 });
 api.get('/folders',async(req,res)=>res.json({folders:(await pool.query('SELECT id,name,created_at FROM folders WHERE owner_id=$1 ORDER BY name',[req.user.id])).rows}));
 api.post('/folders',async(req,res)=>{
  const folder={id:randomUUID(),name:title(req.body.name)};
  await pool.query('INSERT INTO folders(id,owner_id,name) VALUES($1,$2,$3)',[folder.id,req.user.id,folder.name]); res.status(201).json({folder});
 });
 api.patch('/folders/:id',async(req,res)=>{
  const result=await pool.query('UPDATE folders SET name=$1 WHERE id=$2 AND owner_id=$3 RETURNING id,name',[title(req.body.name),id(req.params.id),req.user.id]);
  if(!result.rowCount) fail(404,'文件夹不存在'); res.json({folder:result.rows[0]});
 });
 api.delete('/folders/:id',async(req,res)=>{
  const result=await pool.query('DELETE FROM folders WHERE id=$1 AND owner_id=$2',[id(req.params.id),req.user.id]);
  if(!result.rowCount) fail(404,'文件夹不存在'); res.json({ok:true});
 });
 api.get('/maps',async(req,res)=>{
  const trash=req.query.trash==='1';
  const result=await pool.query('SELECT id,title,folder_id,version,created_at,updated_at,deleted_at FROM maps WHERE owner_id=$1 AND deleted_at IS '+(trash?'NOT NULL':'NULL')+' ORDER BY updated_at DESC LIMIT 1000',[req.user.id]);
  res.json({maps:result.rows});
 });
 api.post('/maps',async(req,res)=>{
  const map=await transaction(pool,async db=>{
   const folder=await checkFolder(db,req.body.folderId,req.user.id);
   const data=cleanMap(req.body.data||emptyMap());
   const result=await db.query('INSERT INTO maps(id,owner_id,folder_id,title,data) VALUES($1,$2,$3,$4,$5) RETURNING *',[randomUUID(),req.user.id,folder,title(req.body.title,'未命名导图'),JSON.stringify(data)]);
   return result.rows[0];
  }); res.status(201).json({map});
 });
 api.get('/maps/:id',async(req,res)=>res.json({map:await ownedMap(pool,req.params.id,req.user.id)}));
 api.put('/maps/:id',async(req,res)=>{
  const map=await transaction(pool,async db=>{
   const old=await ownedMap(db,req.params.id,req.user.id,{lock:true});
   if(!Number.isInteger(req.body.version)||req.body.version!==old.version) fail(409,'这张导图已在其他窗口更新，请保留本地副本后重新加载','VERSION_CONFLICT');
   const data=req.body.data===undefined?old.data:cleanMap(req.body.data);
   const name=req.body.title===undefined?old.title:title(req.body.title);
   const folder=req.body.folderId===undefined?old.folder_id:await checkFolder(db,req.body.folderId,req.user.id);
   await remember(db,old);
   return (await db.query('UPDATE maps SET title=$1,data=$2,folder_id=$3,version=version+1,updated_at=now() WHERE id=$4 RETURNING *',[name,JSON.stringify(data),folder,old.id])).rows[0];
  }); res.json({map});
 });
 api.delete('/maps/:id',async(req,res)=>{
  await transaction(pool,async db=>{
   const map=await ownedMap(db,req.params.id,req.user.id,{lock:true});
   await db.query('UPDATE maps SET deleted_at=now(),updated_at=now(),version=version+1 WHERE id=$1',[map.id]);
   await db.query('UPDATE shares SET revoked_at=now() WHERE map_id=$1 AND revoked_at IS NULL',[map.id]);
  }); res.json({ok:true});
 });
 api.post('/maps/:id/restore',async(req,res)=>{
  const map=await transaction(pool,async db=>{
   const old=await ownedMap(db,req.params.id,req.user.id,{deleted:true,lock:true});
   return (await db.query('UPDATE maps SET deleted_at=NULL,updated_at=now(),version=version+1 WHERE id=$1 RETURNING *',[old.id])).rows[0];
  }); res.json({map});
 });
 api.post('/maps/:id/duplicate',async(req,res)=>{
  const map=await transaction(pool,async db=>{
   const old=await ownedMap(db,req.params.id,req.user.id);
   return (await db.query('INSERT INTO maps(id,owner_id,folder_id,title,data) VALUES($1,$2,$3,$4,$5) RETURNING *',[randomUUID(),req.user.id,old.folder_id,(old.title+' · 副本').slice(0,120),JSON.stringify(old.data)])).rows[0];
  }); res.status(201).json({map});
 });
 api.get('/maps/:id/revisions',async(req,res)=>{
  await ownedMap(pool,req.params.id,req.user.id);
  res.json({revisions:(await pool.query('SELECT id,version,title,created_at FROM revisions WHERE map_id=$1 ORDER BY version DESC',[req.params.id])).rows});
 });
 api.post('/maps/:id/revisions/:revisionId/restore',async(req,res)=>{
  const map=await transaction(pool,async db=>{
   const old=await ownedMap(db,req.params.id,req.user.id,{lock:true});
   if(req.body.version!==old.version) fail(409,'导图已经更新，请重新加载','VERSION_CONFLICT');
   const result=await db.query('SELECT * FROM revisions WHERE id=$1 AND map_id=$2',[id(req.params.revisionId),old.id]);
   if(!result.rowCount) fail(404,'历史版本不存在'); const revision=result.rows[0];
   await remember(db,old);
   return (await db.query('UPDATE maps SET title=$1,data=$2,version=version+1,updated_at=now() WHERE id=$3 RETURNING *',[revision.title,JSON.stringify(revision.data),old.id])).rows[0];
  }); res.json({map});
 });
 api.get('/maps/:id/shares',async(req,res)=>{
  await ownedMap(pool,req.params.id,req.user.id);
  res.json({shares:(await pool.query('SELECT id,created_at,expires_at,revoked_at FROM shares WHERE map_id=$1 ORDER BY created_at DESC LIMIT 100',[req.params.id])).rows});
 });
 api.post('/maps/:id/shares',async(req,res)=>{
  const days=Number(req.body.days ?? 7);
  if(![1,7,30].includes(days)) fail(400,'请选择 1、7 或 30 天有效期');
  const value=token(), shareId=randomUUID(), expires=new Date(Date.now()+days*86400000);
  await transaction(pool,async db=>{
   await ownedMap(db,req.params.id,req.user.id,{lock:true});
   await db.query('INSERT INTO shares(id,map_id,token_hash,expires_at) VALUES($1,$2,$3,$4)',[shareId,req.params.id,digest(value),expires]);
  });
  res.status(201).json({share:{id:shareId,expires_at:expires,url:origin+base+'/s/'+value}});
 });
 api.delete('/maps/:id/shares/:shareId',async(req,res)=>{
  await ownedMap(pool,req.params.id,req.user.id);
  const result=await pool.query('UPDATE shares SET revoked_at=now() WHERE id=$1 AND map_id=$2',[id(req.params.shareId),req.params.id]);
  if(!result.rowCount) fail(404,'分享不存在'); res.json({ok:true});
 });
 api.get('/admin/invites',admin,async(req,res)=>res.json({invites:(await pool.query('SELECT id,role,expires_at,used_by,created_at FROM invites ORDER BY created_at DESC LIMIT 100')).rows}));
 api.post('/admin/invites',admin,async(req,res)=>{
  const value=token(), inviteId=randomUUID(), expires=new Date(Date.now()+7*86400000);
  await pool.query("INSERT INTO invites(id,token_hash,role,created_by,expires_at) VALUES($1,$2,'user',$3,$4)",[inviteId,digest(value),req.user.id,expires]);
  res.status(201).json({invite:{id:inviteId,code:value,expires_at:expires}});
 });
 api.delete('/admin/invites/:id',admin,async(req,res)=>{
  await pool.query('UPDATE invites SET expires_at=now() WHERE id=$1 AND used_by IS NULL',[id(req.params.id)]); res.json({ok:true});
 });
 api.use((req,res)=>res.status(404).json({error:'接口不存在'}));
 app.use(base+'/editor',express.static(editorDir,{index:'index.html',dotfiles:'deny'}));
 app.use(base,express.static(staticDir,{index:false,dotfiles:'deny'}));
 app.get([base,base+'/',base+'/s/:token'],(req,res)=>res.sendFile(path.join(staticDir,'index.html')));
 app.use((error,req,res,next)=>{
  if(res.headersSent) return next(error);
  if(error.code==='23505') return res.status(409).json({error:'名称或账号已存在'});
  if(error.type==='entity.too.large') return res.status(413).json({error:'导图文件过大，最大 12 MB'});
  const status=error.status || 500;
  if(status>=500) console.error('Request failed:',error.code || error.name); // no request contents or credentials
  res.status(status).json({error:status>=500?'服务暂时不可用，请稍后重试':error.message, ...(error.code && status<500?{code:error.code}:{})});
 });
 return app;
}
