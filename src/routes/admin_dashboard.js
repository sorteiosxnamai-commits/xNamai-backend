// src/routes/admin_dashboard.js
import express from "express";
import { getPool, query } from "../db/pg.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

const router = express.Router();

router.use(requireAuth, requireAdmin);

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

function normalizeCashbackPercent(value, fallback = 100) {
  if (value === undefined || value === null || value === "") return fallback;

  const parsed = Number.parseInt(String(value).replace("%", "").trim(), 10);

  if (!Number.isFinite(parsed)) return fallback;

  return Math.max(0, Math.min(100, parsed));
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
  await query(`ALTER TABLE draws ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ`);
  await query(`ALTER TABLE draws ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);
  await query(`ALTER TABLE draws ADD COLUMN IF NOT EXISTS cashback_percent INTEGER NOT NULL DEFAULT 100`);

  await query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'mercadopago'`);
  await query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS coupon_credited BOOLEAN NOT NULL DEFAULT FALSE`);
  await query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS coupon_credited_at TIMESTAMPTZ NULL`);
  await query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS coupon_cashback_percent INTEGER NULL`);
  await query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS coupon_amount_cents INTEGER NULL`);

  await query(`ALTER TABLE coupon_balance_history ADD COLUMN IF NOT EXISTS gross_amount_cents INTEGER NULL`);
  await query(`ALTER TABLE coupon_balance_history ADD COLUMN IF NOT EXISTS cashback_percent INTEGER NULL`);
  await query(`ALTER TABLE coupon_balance_history ADD COLUMN IF NOT EXISTS cashback_amount_cents INTEGER NULL`);

  await query(`ALTER TABLE numbers ADD COLUMN IF NOT EXISTS n SMALLINT`);
  await query(`ALTER TABLE numbers ADD COLUMN IF NOT EXISTS number INTEGER`);
  await query(`ALTER TABLE numbers ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'available'`);
  await query(`ALTER TABLE numbers ADD COLUMN IF NOT EXISTS user_id BIGINT`);
  await query(`ALTER TABLE numbers ADD COLUMN IF NOT EXISTS reservation_id TEXT`);
  await query(`ALTER TABLE numbers ADD COLUMN IF NOT EXISTS payment_id TEXT`);
  await query(`ALTER TABLE numbers ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending'`);
  await query(`ALTER TABLE numbers ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMPTZ`);
  await query(`ALTER TABLE numbers ADD COLUMN IF NOT EXISTS reserved_until TIMESTAMPTZ`);
  await query(`ALTER TABLE numbers ADD COLUMN IF NOT EXISTS purchased_at TIMESTAMPTZ`);
  await query(`ALTER TABLE numbers ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`);
  await query(`ALTER TABLE numbers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);

  await query(`
    UPDATE numbers
       SET n = number::smallint
     WHERE n IS NULL
       AND number IS NOT NULL
  `);

  await query(`
    UPDATE numbers
       SET number = n::int
     WHERE number IS NULL
       AND n IS NOT NULL
  `);

  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS numbers_draw_id_n_unique
    ON numbers(draw_id, n)
  `);
}

async function ensureNumbersForDraw(drawId) {
  if (!Number.isInteger(Number(drawId)) || Number(drawId) <= 0) return;

  await query(
    `
    INSERT INTO numbers(draw_id, n, number, status, created_at, updated_at)
    SELECT $1, gs::smallint, gs::int, 'available', NOW(), NOW()
      FROM generate_series(0, 99) AS gs
    ON CONFLICT (draw_id, n) DO NOTHING
    `,
    [Number(drawId)]
  );
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

  const activeResult = await query(
    `
    SELECT *
      FROM draws
     WHERE LOWER(COALESCE(status, '')) = ANY($1)
     ORDER BY id DESC
     LIMIT 1
    `,
    [OPEN_STATUSES]
  );

  const activeDraw = activeResult.rows[0] || null;

  if (!activeDraw) return null;

  await ensureNumbersForDraw(Number(activeDraw.id));

  const { rows } = await query(
    `
    SELECT
      d.*,

      COUNT(DISTINCT COALESCE(n.n::int, n.number))::int AS total_numbers,

      COUNT(DISTINCT COALESCE(n.n::int, n.number)) FILTER (
        WHERE
          LOWER(COALESCE(n.status, '')) = ANY($1)
          OR LOWER(COALESCE(n.payment_status, '')) IN ('paid', 'approved', 'pago')
          OR (
            LOWER(COALESCE(n.status, '')) = ANY($2)
            AND n.user_id IS NOT NULL
            AND n.reserved_until IS NULL
            AND LOWER(COALESCE(n.payment_status, 'pending')) NOT IN ('expired', 'cancelled', 'canceled')
          )
      )::int AS sold_numbers,

      COUNT(DISTINCT COALESCE(n.n::int, n.number)) FILTER (
        WHERE
          LOWER(COALESCE(n.status, '')) = ANY($2)
          AND LOWER(COALESCE(n.payment_status, 'pending')) NOT IN ('paid', 'approved', 'pago', 'expired', 'cancelled', 'canceled')
          AND NOT (
            n.user_id IS NOT NULL
            AND n.reserved_until IS NULL
          )
          AND (
            n.reserved_until IS NULL
            OR n.reserved_until > NOW()
          )
      )::int AS reserved_numbers,

      COUNT(DISTINCT COALESCE(n.n::int, n.number)) FILTER (
        WHERE LOWER(COALESCE(n.status, '')) = ANY($3)
      )::int AS free_numbers

    FROM draws d
    LEFT JOIN numbers n ON n.draw_id = d.id
    WHERE d.id = $4
    GROUP BY d.id
    LIMIT 1
    `,
    [SOLD_STATUSES, RESERVED_STATUSES, FREE_STATUSES, activeDraw.id]
  );

  return rows[0] || activeDraw;
}

async function handleSummary(_req, res) {
  try {
    const config = await getConfigObject();
    const draw = await getActiveDraw();
    const priceCents = toInt(config.ticket_price_cents ?? config.price_cents, 5500);
    const maxNumbers = toInt(
      config.max_numbers_per_selection ?? config.max_numbers_per_user,
      5
    );
    const promoText = String(config.promo_text || config.banner_title || "");
    const bannerTitle = String(config.banner_title || config.promo_text || "");

    if (!draw) {
      return res.json({
        ok: true,
        draw_id: null,
        sold: 0,
        remaining: 0,
        price_cents: priceCents,
        ticket_price_cents: priceCents,
        max_numbers_per_selection: maxNumbers,
        max_numbers_per_user: maxNumbers,
        promo_text: promoText,
        banner_title: bannerTitle,
        cashback_percent: 100,
        draw: null,
        current_draw: null,
        currentDraw: null,
        sold_numbers: 0,
        remaining_numbers: 0,
        reserved_numbers: 0,
        config,
      });
    }

    const total = Math.max(100, toInt(draw.total_numbers, 0));
    const sold = toInt(draw.sold_numbers, 0);
    const reserved = toInt(draw.reserved_numbers, 0);
    const remaining = Math.max(0, total - sold - reserved);

    const cashbackPercent = normalizeCashbackPercent(draw.cashback_percent, 100);

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
      cashback_percent: cashbackPercent,
    };

    return res.json({
      ok: true,
      draw_id: normalizedDraw.id,
      sold,
      remaining,
      price_cents: normalizedDraw.ticket_price_cents,
      ticket_price_cents: normalizedDraw.ticket_price_cents,
      cashback_percent: cashbackPercent,
      max_numbers_per_selection: config.max_numbers_per_selection,
      max_numbers_per_user: normalizedDraw.max_numbers_per_user,
      promo_text: normalizedDraw.promo_text || promoText,
      banner_title: normalizedDraw.banner_title || bannerTitle,
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
    const currentConfig = await getConfigObject();

    const ticketPriceCents = toCents(
      req.body.ticket_price_cents ?? req.body.price_cents ?? req.body.pix_price,
      currentConfig.ticket_price_cents
    );

    const maxNumbers = toInt(
      req.body.max_numbers_per_selection ?? req.body.max_numbers_per_user,
      currentConfig.max_numbers_per_selection
    );

    const promoText = normalizeText(
      req.body.promo_text ?? req.body.banner_title,
      currentConfig.promo_text || currentConfig.banner_title || ""
    );

    const cashbackPercent = normalizeCashbackPercent(req.body.cashback_percent, 100);

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
        promo_text = $3,
        cashback_percent = $4
      WHERE LOWER(COALESCE(status, '')) = ANY($5)
      `,
      [ticketPriceCents, maxNumbers, promoText, cashbackPercent, OPEN_STATUSES]
    );

    await client.query("COMMIT");

    return res.json({
      ok: true,
      ticket_price_cents: ticketPriceCents,
      max_numbers_per_selection: maxNumbers,
      promo_text: promoText,
      cashback_percent: cashbackPercent,
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
    const currentConfig = await getConfigObject();

    const title = normalizeText(req.body.title, "");
    const prizeTitle = normalizeText(req.body.prize_title ?? req.body.prizeTitle, "");
    const promoText = normalizeText(
      req.body.promo_text ?? req.body.banner_title,
      currentConfig.promo_text || currentConfig.banner_title || ""
    );
    const ticketPriceCents = toCents(
      req.body.ticket_price_cents ?? req.body.price_cents ?? req.body.pix_price,
      currentConfig.ticket_price_cents
    );
    const maxNumbers = toInt(
      req.body.max_numbers_per_selection ?? req.body.max_numbers_per_user,
      currentConfig.max_numbers_per_selection
    );

    const cashbackPercent = normalizeCashbackPercent(req.body.cashback_percent, 100);

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
        cashback_percent,
        started_at,
        opened_at
      )
      VALUES ($1, $2, $3, 'open', $4, $5, $6, NOW(), NOW())
      RETURNING *
      `,
      [finalTitle, prizeTitle, promoText, ticketPriceCents, maxNumbers, cashbackPercent]
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
      draw_id: draw.id,
      draw: {
        ...draw,
        cashback_percent: normalizeCashbackPercent(draw.cashback_percent, 100),
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
        draw_id: null,
        sold: 0,
        remaining: 100,
        reserved: 0,
        total_numbers: 100,
        draw: null,
        buyers: [],
        numbers: [],
      });
    }

    const ticketPriceCents = toInt(active.ticket_price_cents, 5500);

    const occupiedResult = await query(
      `
      WITH paid_numbers AS (
        SELECT DISTINCT ON (paid_num.n)
          paid_num.n::int AS n,
          p.user_id::bigint AS user_id,
          COALESCE(NULLIF(u.name, ''), u.email, 'Cliente #' || p.user_id::text) AS name,
          COALESCE(u.email, '') AS email,
          COALESCE(u.phone, '') AS phone,
          'paid'::text AS source,
          'Pago'::text AS source_label,
          p.id::text AS payment_id,
          NULL::text AS reservation_id,
          COALESCE(
            NULLIF((p.amount_cents / NULLIF(CARDINALITY(COALESCE(p.numbers, '{}'::int[])), 0)), 0),
            d.ticket_price_cents,
            $5
          )::int AS unit_cents,
          1::int AS priority
        FROM public.payments p
        JOIN public.draws d
          ON d.id = p.draw_id
        LEFT JOIN public.users u
          ON u.id = p.user_id
        CROSS JOIN LATERAL UNNEST(COALESCE(p.numbers, '{}'::int[])) AS paid_num(n)
        WHERE p.draw_id = $1
          AND paid_num.n BETWEEN 0 AND 99
          AND LOWER(TRIM(COALESCE(p.status, ''))) = ANY($2)
        ORDER BY paid_num.n, p.created_at DESC NULLS LAST
      ),

      assigned_numbers AS (
        SELECT DISTINCT ON (COALESCE(n.n::int, n.number::int))
          COALESCE(n.n::int, n.number::int) AS n,
          n.user_id::bigint AS user_id,
          COALESCE(NULLIF(u.name, ''), u.email, 'Cliente #' || n.user_id::text, 'Sem usuário') AS name,
          COALESCE(u.email, '') AS email,
          COALESCE(u.phone, '') AS phone,
          CASE
            WHEN LOWER(TRIM(COALESCE(n.payment_status, ''))) = ANY($2)
              OR LOWER(TRIM(COALESCE(n.status, ''))) = ANY($3)
            THEN 'paid'
            ELSE 'admin_assigned'
          END AS source,
          CASE
            WHEN LOWER(TRIM(COALESCE(n.payment_status, ''))) = ANY($2)
              OR LOWER(TRIM(COALESCE(n.status, ''))) = ANY($3)
            THEN 'Pago'
            ELSE 'Atribuído pelo admin'
          END AS source_label,
          n.payment_id::text AS payment_id,
          n.reservation_id::text AS reservation_id,
          COALESCE(d.ticket_price_cents, $5)::int AS unit_cents,
          CASE
            WHEN LOWER(TRIM(COALESCE(n.payment_status, ''))) = ANY($2)
              OR LOWER(TRIM(COALESCE(n.status, ''))) = ANY($3)
            THEN 1
            ELSE 2
          END AS priority
        FROM public.numbers n
        JOIN public.draws d
          ON d.id = n.draw_id
        LEFT JOIN public.users u
          ON u.id = n.user_id
        WHERE n.draw_id = $1
          AND COALESCE(n.n::int, n.number::int) BETWEEN 0 AND 99
          AND (
            LOWER(TRIM(COALESCE(n.status, ''))) = ANY($3)
            OR LOWER(TRIM(COALESCE(n.payment_status, ''))) = ANY($2)
            OR (
              LOWER(TRIM(COALESCE(n.status, ''))) = ANY($4)
              AND n.user_id IS NOT NULL
              AND n.reserved_until IS NULL
              AND LOWER(TRIM(COALESCE(n.payment_status, 'pending'))) NOT IN (
                'expired',
                'cancelled',
                'canceled',
                'cancelado'
              )
            )
          )
        ORDER BY COALESCE(n.n::int, n.number::int), n.updated_at DESC NULLS LAST
      ),

      merged AS (
        SELECT * FROM paid_numbers
        UNION ALL
        SELECT * FROM assigned_numbers
      ),

      ranked AS (
        SELECT DISTINCT ON (n)
          *
        FROM merged
        ORDER BY n, priority ASC
      )

      SELECT *
      FROM ranked
      ORDER BY n ASC
      `,
      [
        active.id,
        PAID_PAYMENT_STATUSES,
        SOLD_STATUSES,
        RESERVED_STATUSES,
        ticketPriceCents,
      ]
    );

    const reservedResult = await query(
      `
      SELECT
        COUNT(DISTINCT COALESCE(n.n::int, n.number::int))::int AS reserved_count
      FROM public.numbers n
      WHERE n.draw_id = $1
        AND COALESCE(n.n::int, n.number::int) BETWEEN 0 AND 99
        AND LOWER(TRIM(COALESCE(n.status, ''))) = ANY($2)
        AND LOWER(TRIM(COALESCE(n.payment_status, 'pending'))) NOT IN (
          'paid',
          'approved',
          'pago',
          'expired',
          'cancelled',
          'canceled',
          'cancelado'
        )
        AND NOT (
          n.user_id IS NOT NULL
          AND n.reserved_until IS NULL
        )
        AND (
          n.reserved_until IS NULL
          OR n.reserved_until > NOW()
        )
      `,
      [active.id, RESERVED_STATUSES]
    );

    const occupiedNumbers = occupiedResult.rows || [];
    const reserved = Number(reservedResult.rows?.[0]?.reserved_count || 0);
    const sold = occupiedNumbers.length;
    const remaining = Math.max(0, 100 - sold - reserved);

    const pad2 = (value) => String(Number(value)).padStart(2, "0");

    const buyerMap = new Map();

    for (const row of occupiedNumbers) {
      const userId = row.user_id ? Number(row.user_id) : null;
      const buyerKey = userId
        ? `user:${userId}`
        : `guest:${row.email || row.name || "sem-usuario"}`;

      if (!buyerMap.has(buyerKey)) {
        buyerMap.set(buyerKey, {
          buyer_key: buyerKey,
          user_id: userId,
          name: row.name || "Sem usuário",
          email: row.email || "",
          phone: row.phone || "",
          numbers: [],
          qtd: 0,
          count: 0,
          quantity: 0,
          value_cents: 0,
          total_cents: 0,
          amount_cents: 0,
          paid_count: 0,
          assigned_count: 0,
          sources: [],
        });
      }

      const buyer = buyerMap.get(buyerKey);
      const number = Number(row.n);

      buyer.numbers.push(number);
      buyer.qtd += 1;
      buyer.count += 1;
      buyer.quantity += 1;
      buyer.value_cents += Number(row.unit_cents || ticketPriceCents);
      buyer.total_cents += Number(row.unit_cents || ticketPriceCents);
      buyer.amount_cents += Number(row.unit_cents || ticketPriceCents);

      if (row.source === "admin_assigned") {
        buyer.assigned_count += 1;
      } else {
        buyer.paid_count += 1;
      }

      if (row.source_label && !buyer.sources.includes(row.source_label)) {
        buyer.sources.push(row.source_label);
      }
    }

    const buyers = Array.from(buyerMap.values())
      .map((buyer) => ({
        ...buyer,
        numbers: buyer.numbers.sort((a, b) => a - b),
        numbers_label: buyer.numbers
          .sort((a, b) => a - b)
          .map(pad2)
          .join(", "),
        source_label: buyer.sources.includes("Atribuído pelo admin")
          ? buyer.sources.includes("Pago")
            ? "Pago + atribuído pelo admin"
            : "Atribuído pelo admin"
          : "Pago",
      }))
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return String(a.name || "").localeCompare(String(b.name || ""), "pt-BR");
      });

    const numbers = occupiedNumbers.map((row) => {
      const number = Number(row.n);
      const userId = row.user_id ? Number(row.user_id) : null;
      const buyerKey = userId
        ? `user:${userId}`
        : `guest:${row.email || row.name || "sem-usuario"}`;

      return {
        n: number,
        number,
        label: pad2(number),
        buyer_key: buyerKey,
        user_id: userId,
        name: row.name || "Sem usuário",
        email: row.email || "",
        phone: row.phone || "",
        source: row.source || "paid",
        source_label: row.source_label || "Pago",
        payment_id: row.payment_id || null,
        reservation_id: row.reservation_id || null,
        unit_cents: Number(row.unit_cents || ticketPriceCents),
        value_cents: Number(row.unit_cents || ticketPriceCents),
      };
    });

    const normalizedDraw = {
      ...active,
      id: Number(active.id),
      total_numbers: 100,
      sold_numbers: sold,
      reserved_numbers: reserved,
      remaining_numbers: remaining,
      ticket_price_cents: ticketPriceCents,
    };

    return res.json({
      ok: true,
      draw_id: Number(active.id),
      sold,
      sold_numbers: sold,
      reserved,
      reserved_numbers: reserved,
      remaining,
      remaining_numbers: remaining,
      total_numbers: 100,
      draw: normalizedDraw,
      buyers,
      participants: buyers,
      numbers,
    });
  } catch (err) {
    console.error("[admin.dashboard.open-buyers]", {
      message: err?.message,
      code: err?.code,
      detail: err?.detail,
      stack: err?.stack,
    });

    return res.status(500).json({
      ok: false,
      error: "admin_dashboard_open_buyers_failed",
      message: err.message,
    });
  }
});

export default router;
