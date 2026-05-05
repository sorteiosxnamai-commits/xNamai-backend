import pg from "pg";

const { Pool } = pg;

function cleanUrl(rawUrl) {
  if (!rawUrl) return "";

  const value = String(rawUrl).trim().replace(/^["']|["']$/g, "");

  try {
    const url = new URL(value);

    url.searchParams.delete("sslmode");
    url.searchParams.delete("pgbouncer");

    // Se sobrar "?" vazio, URL() normaliza ao serializar
    return url.toString();
  } catch {
    return value;
  }
}

function maskUrl(rawUrl) {
  if (!rawUrl) return "";

  try {
    const url = new URL(rawUrl);
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return String(rawUrl).replace(/:[^:@/]+@/, ":***@");
  }
}

const databaseUrl =
  cleanUrl(process.env.DATABASE_URL) ||
  cleanUrl(process.env.POSTGRES_URL) ||
  cleanUrl(process.env.POSTGRES_PRISMA_URL);

if (!databaseUrl) {
  throw new Error("[pg] Nenhuma DATABASE_URL/POSTGRES_URL encontrada no .env");
}

// Log seguro (sem senha/URL completa)
console.log("[pg] usando DATABASE_URL:", maskUrl(databaseUrl));

let pool;

export async function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl,
      ssl: { rejectUnauthorized: false },
      max: Number(process.env.PG_POOL_MAX || process.env.PG_MAX || 10),
      idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT || 30000),
      connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT || 15000),
      keepAlive: true,
    });

    pool.on("error", (err) => {
      console.error("[pg] pool error:", err?.code || err?.message);
    });

    await pool.query("SELECT 1");
    console.log("[pg] conexão ok");
  }

  return pool;
}

export async function query(text, params) {
  const db = await getPool();
  return db.query(text, params);
}

export async function endPool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}