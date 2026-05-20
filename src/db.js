export { query, getPool, endPool } from './db/pg.js';
import { query } from './db/pg.js';

let userProfileColumnsReady = false;

export async function ensureUserProfileColumns() {
  if (userProfileColumnsReady) return;
  try {
    await query(`
      ALTER TABLE IF EXISTS public.users
        ADD COLUMN IF NOT EXISTS cpf text,
        ADD COLUMN IF NOT EXISTS zip_code text,
        ADD COLUMN IF NOT EXISTS street text,
        ADD COLUMN IF NOT EXISTS street_number text,
        ADD COLUMN IF NOT EXISTS neighborhood text
    `);
    userProfileColumnsReady = true;
  } catch (e) {
    console.warn('[db] ensureUserProfileColumns:', e?.message || e);
  }
}