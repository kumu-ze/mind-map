import pg from 'pg';
import { readFile } from 'node:fs/promises';
export function createPool(connectionString = process.env.DATABASE_URL) { return new pg.Pool({ connectionString, max: 10 }); }
export async function migrate(pool) { await pool.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8')); }
export async function transaction(pool, fn) {
 const client = await pool.connect();
 try { await client.query('BEGIN'); const value = await fn(client); await client.query('COMMIT'); return value; }
 catch (error) { await client.query('ROLLBACK'); throw error; }
 finally { client.release(); }
}
