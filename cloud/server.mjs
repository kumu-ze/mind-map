import { createPool,migrate } from './db.mjs';
import { createApp } from './app.mjs';
if(!process.env.DATABASE_URL || !process.env.PUBLIC_URL) throw new Error('DATABASE_URL and PUBLIC_URL are required');
const pool=createPool(); await migrate(pool);
await pool.query('DELETE FROM sessions WHERE expires_at<now()');
const app=createApp({pool,publicUrl:process.env.PUBLIC_URL,secureCookies:process.env.COOKIE_SECURE!=='false'});
const server=app.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('Konon Mindmap listening'));
const cleanup=setInterval(()=>pool.query('DELETE FROM sessions WHERE expires_at<now()').catch(()=>{}),3600000); cleanup.unref();
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>server.close(async()=>{clearInterval(cleanup);await pool.end();process.exit(0);}));
