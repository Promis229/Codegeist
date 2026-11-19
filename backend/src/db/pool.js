import pg from 'pg';
import { env } from '../config/env.js';

// Les timestamptz restent des objets Date ; les bigint (count) sont renvoyes en nombre.
pg.types.setTypeParser(20, (v) => Number(v));
// numeric (EXTRACT, avg, division) revient en TEXTE par defaut : "12.3" + "4.2" donnerait "12.34.2" dans les statistiques.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({ connectionString: env.databaseUrl, max: 12, idleTimeoutMillis: 30000 });
pool.on('error', (e) => console.error('pg pool error', e.message));

export const query = (text, params) => pool.query(text, params);
export const one = async (text, params) => (await pool.query(text, params)).rows[0] ?? null;
export const many = async (text, params) => (await pool.query(text, params)).rows;

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn({
      query: (t, p) => client.query(t, p),
      one: async (t, p) => (await client.query(t, p)).rows[0] ?? null,
      many: async (t, p) => (await client.query(t, p)).rows,
    });
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
