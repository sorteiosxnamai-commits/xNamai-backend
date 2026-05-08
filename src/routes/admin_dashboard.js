// src/routes/admin_dashboard.js
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
    console.error("[admin.dashboard] admin check", e);
    return res.status(500).json({ error: "admin_check_failed" });
  }
}

router.use(requireAdminDb);

const OPEN_STATUSES = ["open", "active", "aberto", "ativo"];
const SOLD_STATUSES = ["paid", "sold", "approved", "pago", "vendido", "aprovado"];
const RESERVED_STATUSES = ["reserved", "pending", "reservado", "pendente"];
const FREE_STATUSES = ["available", "free", "livre", "disponivel", "disponível"];

const PAID_PAYMENT_STATUSES = ["approved", "paid", "pago"];

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function toCents(value, fallback = 5500) {
  if (value === undefined || value === null || value === "") return fallback;

  const raw = String(value).trim();

  if (/^\d+$/.test(raw)) {
    return Math.max(0, Number(raw));
  }

  const normalized = raw.replace(/[^\d,.-]/g, "").replace(",", ".");
  const n = Number(normalized);

  if (!Number.isFinite(n)) return fallback;

  return Math.max(0, Math.round(n * 100));
}

function normalizeText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
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

async function upsertConfig(client, key, value) {
  await client.query(
    `
    INSERT INTO app_config(key, value)
    VALUES ($1, $2)
    ON CONFLICT (key)
    DO UPDATE SET value = EXCLUDED.value
    `,
    [key, String(value)]
  );
}

async function getConfigObject() {
  await ensureAdminSchema();

  const { rows } = await query(`
    SELECT key, value
    FROM app_config
    WHERE key IN (
      'draw_id',
      'default_draw_id',
      'ticket_price_cents',
      'price_cents',
      'pix_price',
      'max_numbers_per_selection',
      'max_numbers_per_user',
      'banner_title',
      'promo_text'
    )
  `);

  const config = {};
  for (const row of rows) {
    config[row.key] = row.value;
  }

  return {
    draw_id: toInt(config.draw_id || config.default_draw_id, 0),
    default_draw_id: toInt(config.default_draw_id || config.draw_id, 0),
    ticket_price_cents: toInt(
      config.ticket_price_cents || config.price_cents || config.pix_price,
      5500
    ),
    price_cents: toInt(
      config.price_cents || config.ticket_price_cents || config.pix_price,
      5500
    ),
    max_numbers_per_selection: toInt(
      config.max_numbers_per_selection || config.max_numbers_per_user,
      5
    ),
    max_numbers_per_user: toInt(
      config.max_numbers_per_user || config.max_numbers_per_selection,
      5
    ),
    banner_title: config.banner_title || "",
    promo_text: config.promo_text || "",
  };
}

async function getActiveDraw() {
  await ensureAdminSchema();

  const { rows } = await query(
    `
    SELECT
      d.*,
      COUNT(n.id)::int AS total_numbers,
      COUNT(n.id) FILTER (WHERE LOWER(COALESCE(n.status, '')) = ANY($1))::int AS sold_numbers,
      COUNT(n.id) FILTER (WHERE LOWER(COALESCE(n.status, '')) = ANY($2))::int AS reserved_numbers,
      COUNT(n.id) FILTER (WHERE LOWER(COALESCE(n.status, '')) = ANY($3))::int AS free_numbers
    FROM draws d
    LEFT JOIN numbers n ON n.draw_id = d.id
    WHERE LOWER(COALESCE(d.status, '')) = ANY($4)
    GROUP BY d.id
    ORDER BY d.id DESC
    LIMIT 1
    `,
    [SOLD_STATUSES, RESERVED_STATUSES, FREE_STATUSES, OPEN_STATUSES]
  );

  return rows[0] || null;
}

async function handleSummary(_req, res) {
  try {
    const config = await getConfigObject();
    const draw = await getActiveDraw();

    if (!draw) {
      return res.json({
        ok: true,
        draw: null,
        current_draw: null,
        currentDraw: null,
        sold_numbers: 0,
        remaining_numbers: 0,
        reserved_numbers: 0,
        config,
      });
    }

    const total = toInt(draw.total_numbers, 0);
    const sold = toInt(draw.sold_numbers, 0);
    const reserved = toInt(draw.reserved_numbers, 0);
    const remaining = Math.max(0, total - sold - reserved);

    const normalizedDraw = {
      ...draw,
      id: draw.id,
      number: draw.id,
      total_numbers: total,
      sold_numbers: sold,
      reserved_numbers: reserved,
      remaining_numbers: remaining,
      ticket_price_cents: toInt(draw.ticket_price_cents, config.ticket_price_cents),
      max_numbers_per_user: toInt(draw.max_numbers_per_user, config.max_numbers_per_user),
    };

    return res.json({
      ok: true,
      draw: normalizedDraw,
      current_draw: normalizedDraw,
      currentDraw: normalizedDraw,
      sold_numbers: sold,
      remaining_numbers: remaining,
      reserved_numbers: reserved,
      config,
    });
  } catch (err) {
    console.error("[admin.dashboard.summary]", err);
    return res.status(500).json({
      ok: false,
      error: "admin_dashboard_summary_failed",
      message: err.message,
    });
  }
}

router.get("/", handleSummary);
router.get("/summary", handleSummary);

router.patch("/config", async (req, res) => {
  const pool = await getPool();
  const client = await pool.connect();

  try {
    await ensureAdminSchema();

    const ticketPriceCents = toCents(
      req.body.ticket_price_cents ?? req.body.price_cents ?? req.body.pix_price,
      5500
    );

    const maxNumbers = toInt(
      req.body.max_numbers_per_selection ?? req.body.max_numbers_per_user,
      5
    );

    const promoText = normalizeText(req.body.promo_text ?? req.body.banner_title, "");

    await client.query("BEGIN");

    await upsertConfig(client, "ticket_price_cents", ticketPriceCents);
    await upsertConfig(client, "price_cents", ticketPriceCents);
    await upsertConfig(client, "pix_price", ticketPriceCents);
    await upsertConfig(client, "max_numbers_per_selection", maxNumbers);
    await upsertConfig(client, "max_numbers_per_user", maxNumbers);
    await upsertConfig(client, "promo_text", promoText);
    await upsertConfig(client, "banner_title", promoText);

    await client.query(
      `
      UPDATE draws
      SET
        ticket_price_cents = $1,
        max_numbers_per_user = $2,
        promo_text = $3
      WHERE LOWER(COALESCE(status, '')) = ANY($4)
      `,
      [ticketPriceCents, maxNumbers, promoText, OPEN_STATUSES]
    );

    await client.query("COMMIT");

    return res.json({
      ok: true,
      ticket_price_cents: ticketPriceCents,
      max_numbers_per_selection: maxNumbers,
      promo_text: promoText,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[admin.dashboard.config]", err);
    return res.status(500).json({
      ok: false,
      error: "admin_dashboard_config_failed",
      message: err.message,
    });
  } finally {
    client.release();
  }
});

router.post("/new", async (req, res) => {
  const pool = await getPool();
  const client = await pool.connect();

  try {
    await ensureAdminSchema();

    const title = normalizeText(req.body.title, "");
    const prizeTitle = normalizeText(req.body.prize_title ?? req.body.prizeTitle, "");
    const promoText = normalizeText(req.body.promo_text ?? req.body.banner_title, "");
    const ticketPriceCents = toCents(
      req.body.ticket_price_cents ?? req.body.price_cents ?? req.body.pix_price,
      5500
    );
    const maxNumbers = toInt(
      req.body.max_numbers_per_selection ?? req.body.max_numbers_per_user,
      5
    );

    const finalTitle = title || prizeTitle || `Sorteio ${new Date().toLocaleDateString("pt-BR")}`;

    await client.query("BEGIN");

    await client.query(
      `
      UPDATE draws
      SET status = 'closed',
          closed_at = COALESCE(closed_at, NOW())
      WHERE LOWER(COALESCE(status, '')) = ANY($1)
      `,
      [OPEN_STATUSES]
    );

    const inserted = await client.query(
      `
      INSERT INTO draws (
        title,
        prize_title,
        promo_text,
        status,
        ticket_price_cents,
        max_numbers_per_user,
        started_at,
        opened_at
      )
      VALUES ($1, $2, $3, 'open', $4, $5, NOW(), NOW())
      RETURNING *
      `,
      [finalTitle, prizeTitle, promoText, ticketPriceCents, maxNumbers]
    );

    const draw = inserted.rows[0];

    await client.query(
      `
      INSERT INTO numbers(draw_id, n, status)
      SELECT $1, gs, 'available'
      FROM generate_series(0, 99) AS gs
      ON CONFLICT (draw_id, n) DO NOTHING
      `,
      [draw.id]
    );

    await upsertConfig(client, "draw_id", draw.id);
    await upsertConfig(client, "default_draw_id", draw.id);
    await upsertConfig(client, "ticket_price_cents", ticketPriceCents);
    await upsertConfig(client, "price_cents", ticketPriceCents);
    await upsertConfig(client, "pix_price", ticketPriceCents);
    await upsertConfig(client, "max_numbers_per_selection", maxNumbers);
    await upsertConfig(client, "max_numbers_per_user", maxNumbers);
    await upsertConfig(client, "promo_text", promoText);
    await upsertConfig(client, "banner_title", promoText);

    await client.query("COMMIT");

    return res.status(201).json({
      ok: true,
      message: "Sorteio criado com sucesso.",
      draw: {
        ...draw,
        total_numbers: 100,
        sold_numbers: 0,
        reserved_numbers: 0,
        remaining_numbers: 100,
      },
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[admin.dashboard.new]", err);
    return res.status(500).json({
      ok: false,
      error: "admin_dashboard_new_failed",
      message: err.message,
    });
  } finally {
    client.release();
  }
});

router.get("/open-buyers", async (req, res) => {
  try {
    await ensureAdminSchema();

    const active = await getActiveDraw();

    if (!active) {
      return res.json({
        ok: true,
        draw: null,
        buyers: [],
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
      [active.id, PAID_PAYMENT_STATUSES]
    );

    return res.json({
      ok: true,
      draw: active,
      buyers: rows,
    });
  } catch (err) {
    console.error("[admin.dashboard.open-buyers]", err);
    return res.status(500).json({
      ok: false,
      error: "admin_dashboard_open_buyers_failed",
      message: err.message,
    });
  }
});

export default router;
