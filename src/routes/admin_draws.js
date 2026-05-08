// src/routes/admin_draws.js
import express from "express";
import { getPool, query } from "../db/pg.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

router.use(requireAuth);

async function requireAdminDb(req, res, next) {
  try {
    const userId = req?.user?.id;
    if (!userId) return res.status(401).json({ error: "unauthorized" });
    const r = await query("SELECT is_admin FROM users WHERE id = $1", [userId]);
    if (!r.rows.length || !r.rows[0].is_admin) {
      return res.status(403).json({ error: "forbidden" });
    }
    return next();
  } catch (e) {
    console.error("[admin.draws] admin check", e);
    return res.status(500).json({ error: "admin_check_failed" });
  }
}

router.use(requireAdminDb);

const OPEN_STATUSES = ["open", "active", "aberto", "ativo"];
const SOLD_STATUSES = ["paid", "sold", "approved", "pago", "vendido", "aprovado"];
const RESERVED_STATUSES = ["reserved", "pending", "reservado", "pendente"];
const FREE_STATUSES = ["available", "free", "livre", "disponivel", "disponível"];

const PAID_PAYMENT_STATUSES = ["approved", "paid", "pago"];

function toStatus(value) {
  const status = String(value || "").trim().toLowerCase();

  if (["open", "active", "aberto", "ativo"].includes(status)) return "open";
  if (["closed", "finished", "encerrado", "finalizado"].includes(status)) return "closed";
  if (["draft", "rascunho"].includes(status)) return "draft";

  return "closed";
}

async function ensureAdminSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  await query(`ALTER TABLE draws ADD COLUMN IF NOT EXISTS title TEXT`);
  await query(`ALTER TABLE draws ADD COLUMN IF NOT EXISTS prize_title TEXT`);
  await query(`ALTER TABLE draws ADD COLUMN IF NOT EXISTS promo_text TEXT`);
  await query(`ALTER TABLE draws ADD COLUMN IF NOT EXISTS ticket_price_cents INTEGER DEFAULT 5500`);
  await query(`ALTER TABLE draws ADD COLUMN IF NOT EXISTS max_numbers_per_user INTEGER DEFAULT 5`);
  await query(`ALTER TABLE draws ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ DEFAULT NOW()`);
  await query(`ALTER TABLE draws ADD COLUMN IF NOT EXISTS result_at TIMESTAMPTZ`);
  await query(`ALTER TABLE draws ADD COLUMN IF NOT EXISTS winner_user_id INTEGER`);
  await query(`ALTER TABLE draws ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`);
  await query(`ALTER TABLE draws ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ DEFAULT NOW()`);

  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS numbers_draw_id_n_unique
    ON numbers(draw_id, n)
  `);
}

async function ensureNumbersForDraw(client, drawId) {
  await client.query(
    `
    INSERT INTO numbers(draw_id, n, status)
    SELECT $1, gs, 'available'
    FROM generate_series(0, 99) AS gs
    ON CONFLICT (draw_id, n) DO NOTHING
    `,
    [drawId]
  );
}

router.get("/history", async (req, res) => {
  try {
    await ensureAdminSchema();

    const { rows } = await query(
      `
      SELECT
        d.id,
        d.title,
        d.prize_title,
        d.promo_text,
        d.status,
        d.ticket_price_cents,
        d.max_numbers_per_user,
        COALESCE(d.opened_at, d.started_at, d.created_at, NOW()) AS opened_at,
        d.closed_at,
        d.result_at,
        COUNT(n.id)::int AS total_numbers,
        COUNT(n.id) FILTER (WHERE LOWER(COALESCE(n.status, '')) = ANY($1))::int AS sold_numbers,
        COUNT(n.id) FILTER (WHERE LOWER(COALESCE(n.status, '')) = ANY($2))::int AS reserved_numbers,
        COUNT(n.id) FILTER (WHERE LOWER(COALESCE(n.status, '')) = ANY($3))::int AS free_numbers
      FROM draws d
      LEFT JOIN numbers n ON n.draw_id = d.id
      GROUP BY d.id
      ORDER BY d.id DESC
      `,
      [SOLD_STATUSES, RESERVED_STATUSES, FREE_STATUSES]
    );

    const draws = rows.map((row) => {
      const total = Number(row.total_numbers || 0);
      const sold = Number(row.sold_numbers || 0);
      const reserved = Number(row.reserved_numbers || 0);

      return {
        ...row,
        remaining_numbers: Math.max(0, total - sold - reserved),
      };
    });

    return res.json({
      ok: true,
      draws,
    });
  } catch (err) {
    console.error("[admin.draws.history]", err);
    return res.status(500).json({
      ok: false,
      error: "admin_draws_history_failed",
      message: err.message,
    });
  }
});

router.get("/:id/buyers", async (req, res) => {
  try {
    await ensureAdminSchema();

    const drawId = Number(req.params.id);

    if (!Number.isInteger(drawId) || drawId <= 0) {
      return res.status(400).json({
        ok: false,
        message: "ID do sorteio inválido.",
      });
    }

    const { rows } = await query(
      `
      SELECT
        COALESCE(u.id, 0) AS user_id,
        COALESCE(u.name, 'Sem usuário') AS name,
        COALESCE(u.email, '') AS email,
        COUNT(*)::int AS qtd,
        COALESCE(
          json_agg(LPAD(num.n::text, 2, '0') ORDER BY num.n)
          FILTER (WHERE num.n IS NOT NULL),
          '[]'::json
        ) AS numbers,
        (COUNT(*)::int * COALESCE(d.ticket_price_cents, 5500))::int AS value_cents
      FROM payments p
      JOIN draws d ON d.id = p.draw_id
      JOIN users u ON u.id = p.user_id
      CROSS JOIN LATERAL unnest(p.numbers) AS num(n)
      WHERE p.draw_id = $1
        AND lower(trim(coalesce(p.status, ''))) = ANY($2)
      GROUP BY u.id, u.name, u.email, d.ticket_price_cents
      ORDER BY qtd DESC, name ASC
      `,
      [drawId, PAID_PAYMENT_STATUSES]
    );

    return res.json({
      ok: true,
      buyers: rows,
    });
  } catch (err) {
    console.error("[admin.draws.buyers]", err);
    return res.status(500).json({
      ok: false,
      error: "admin_draws_buyers_failed",
      message: err.message,
    });
  }
});

router.patch("/:id/status", async (req, res) => {
  const pool = await getPool();
  const client = await pool.connect();

  try {
    await ensureAdminSchema();

    const drawId = Number(req.params.id);

    if (!Number.isInteger(drawId) || drawId <= 0) {
      return res.status(400).json({
        ok: false,
        message: "ID do sorteio inválido.",
      });
    }

    const status = toStatus(req.body.status);

    await client.query("BEGIN");

    if (status === "open") {
      await client.query(
        `
        UPDATE draws
        SET status = 'closed',
            closed_at = COALESCE(closed_at, NOW())
        WHERE LOWER(COALESCE(status, '')) = ANY($1)
          AND id <> $2
        `,
        [OPEN_STATUSES, drawId]
      );

      await client.query(
        `
        UPDATE draws
        SET status = 'open',
            opened_at = COALESCE(opened_at, NOW()),
            closed_at = NULL
        WHERE id = $1
        `,
        [drawId]
      );

      await ensureNumbersForDraw(client, drawId);

      await client.query(
        `
        INSERT INTO app_config(key, value)
        VALUES ('draw_id', $1), ('default_draw_id', $1)
        ON CONFLICT (key)
        DO UPDATE SET value = EXCLUDED.value
        `,
        [String(drawId)]
      );
    } else {
      await client.query(
        `
        UPDATE draws
        SET status = $2,
            closed_at = CASE
              WHEN $2 = 'closed' THEN COALESCE(closed_at, NOW())
              ELSE closed_at
            END
        WHERE id = $1
        `,
        [drawId, status]
      );
    }

    await client.query("COMMIT");

    return res.json({
      ok: true,
      id: drawId,
      status,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[admin.draws.status]", err);
    return res.status(500).json({
      ok: false,
      error: "admin_draws_status_failed",
      message: err.message,
    });
  } finally {
    client.release();
  }
});

export default router;
