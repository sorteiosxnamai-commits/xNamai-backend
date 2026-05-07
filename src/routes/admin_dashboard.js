import { Router } from "express";
import { getPool, query } from "../db.js";
import { runAutopayForDraw } from "../services/autopayRunner.js";

const router = Router();

const toInt = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

router.get("/", async (_req, res, next) => {
  try {
    const cfg = await query(
      `SELECT key, value FROM app_config
       WHERE key IN ('ticket_price_cents','max_numbers_per_selection','banner_title')`
    );

    const config = {
      ticket_price_cents: 5500,
      max_numbers_per_selection: 5,
      banner_title: "",
    };

    for (const row of cfg.rows) {
      if (row.key === "ticket_price_cents") {
        config.ticket_price_cents = Number(row.value || 5500);
      }

      if (row.key === "max_numbers_per_selection") {
        config.max_numbers_per_selection = Number(row.value || 5);
      }

      if (row.key === "banner_title") {
        config.banner_title = row.value || "";
      }
    }

    const draw = await query(
      `SELECT id, status, product_name, product_link, created_at, closed_at
       FROM draws
       WHERE status = 'open'
       ORDER BY id DESC
       LIMIT 1`
    );

    const currentDraw = draw.rows[0] || null;

    let sold = 0;
    let remaining = 100;

    if (currentDraw) {
      const stats = await query(
        `SELECT
          COUNT(*) FILTER (WHERE status = 'sold')::int AS sold,
          COUNT(*) FILTER (WHERE status = 'available')::int AS remaining
         FROM numbers
         WHERE draw_id = $1`,
        [currentDraw.id]
      );

      sold = Number(stats.rows[0]?.sold || 0);
      remaining = Number(stats.rows[0]?.remaining || 0);
    }

    res.json({
      ok: true,
      config,
      current_draw: currentDraw,
      stats: {
        sold,
        remaining,
        total: 100,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post("/config", async (req, res, next) => {
  try {
    const ticketPrice = toInt(req.body.ticket_price_cents, 5500);
    const maxTickets = toInt(req.body.max_numbers_per_selection, 5);
    const bannerTitle = String(req.body.banner_title || "");

    await query(
      `INSERT INTO app_config (key, value, updated_at)
       VALUES
        ('ticket_price_cents', $1, NOW()),
        ('max_numbers_per_selection', $2, NOW()),
        ('banner_title', $3, NOW())
       ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [String(ticketPrice), String(maxTickets), bannerTitle]
    );

    res.json({
      ok: true,
      config: {
        ticket_price_cents: ticketPrice,
        max_numbers_per_selection: maxTickets,
        banner_title: bannerTitle,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post("/new", async (req, res, next) => {
  const pool = getPool();
  const client = await pool.connect();

  try {
    const productName = String(req.body.product_name || "").trim() || null;
    const productLink = String(req.body.product_link || "").trim() || null;

    await client.query("BEGIN");

    await client.query(
      `UPDATE draws
       SET status = 'closed', closed_at = NOW()
       WHERE status = 'open'`
    );

    const insertedDraw = await client.query(
      `INSERT INTO draws (status, product_name, product_link, created_at)
       VALUES ('open', $1, $2, NOW())
       RETURNING id, status, product_name, product_link, created_at`,
      [productName, productLink]
    );

    const draw = insertedDraw.rows[0];

    await client.query(
      `INSERT INTO numbers (draw_id, n, status)
       SELECT $1, gs.n, 'available'
       FROM generate_series(0, 99) AS gs(n)`,
      [draw.id]
    );

    await client.query("COMMIT");

    runAutopayForDraw(draw.id).catch((error) => {
      console.error("[autopay] erro ao rodar compra automática:", error?.message || error);
    });

    res.json({
      ok: true,
      message: "Novo sorteio criado com números de 00 até 99.",
      draw,
      numbers_created: 100,
      numbers_range: "00-99",
    });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

export default router;
