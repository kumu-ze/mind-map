import {randomUUID,randomBytes} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createPool,migrate,transaction} from '../db.mjs';
import {hashPassword} from '../security.mjs';
const pool=createPool(), file=process.env.QA_FILE||'/run/private/browser-qa.json';
try {
 if(process.argv[2]==='seed') {
  await migrate(pool);
  const suffix=randomBytes(4).toString('hex'), password=randomBytes(24).toString('base64url');
  const accounts=[{id:randomUUID(),username:'qa_admin_'+suffix,role:'admin'},{id:randomUUID(),username:'qa_alice_'+suffix,role:'user'},{id:randomUUID(),username:'qa_bob_'+suffix,role:'user'}];
  const hashed=await hashPassword(password);
  await transaction(pool,async db=>{for(const a of accounts) await db.query('INSERT INTO users(id,username,display_name,password_hash,role) VALUES($1,$2,$3,$4,$5)',[a.id,a.username,'验收账号',hashed,a.role]);});
  await mkdir('/run/private',{recursive:true});
  await writeFile(file,JSON.stringify({url:process.env.PUBLIC_URL,password,accounts,registerUsername:'qa_register_'+suffix},null,2),{mode:0o600});
  console.log('Temporary browser fixture written privately.');
 } else if(process.argv[2]==='clean') {
  const fixture=JSON.parse(await readFile(file,'utf8'));
  if(!fixture.accounts.every(a=>/^qa_(admin|alice|bob)_[a-f0-9]{8}$/.test(a.username))) throw new Error('Invalid QA manifest');
  const ids=fixture.accounts.map(a=>a.id);
  const extra=await pool.query('SELECT id FROM users WHERE username=$1',[fixture.registerUsername]);ids.push(...extra.rows.map(r=>r.id));
  await transaction(pool,async db=>{
   await db.query('DELETE FROM invites WHERE created_by=ANY($1::uuid[]) OR used_by=ANY($1::uuid[])',[ids]);
   await db.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[ids]);
  }); console.log('Only task-created browser users and their data were removed.');
 } else throw new Error('Expected seed or clean');
} finally {await pool.end();}
