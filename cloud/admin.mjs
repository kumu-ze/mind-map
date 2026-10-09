import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { createPool, migrate } from './db.mjs';
import { token, digest } from './security.mjs';
const pool = createPool();
try {
 await migrate(pool);
 const existing = await pool.query("SELECT count(*)::int AS count FROM users WHERE role='admin'");
 if (existing.rows[0].count) throw new Error('An administrator already exists; use its invitation screen.');
 const value = token();
 // Only one unclaimed bootstrap invitation remains valid.
 await pool.query("UPDATE invites SET expires_at=now() WHERE role='admin' AND used_by IS NULL");
 await pool.query("INSERT INTO invites(id,token_hash,role,expires_at) VALUES($1,$2,'admin',now()+interval '7 days')", [randomUUID(),digest(value)]);
 const file = process.env.BOOTSTRAP_FILE || '/run/private/bootstrap-invite.txt';
 await mkdir(new URL('.', 'file://' + file).pathname, {recursive:true});
 await writeFile(file, 'Konon Mindmap administrator invitation (single use, expires in 7 days)\nOpen: ' + process.env.PUBLIC_URL + '\nChoose invitation registration and enter this code:\n' + value + '\n', {mode:0o600});
 console.log('Bootstrap invitation written to private file; token not printed.');
} finally { await pool.end(); }
