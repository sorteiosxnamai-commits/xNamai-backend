// backend/src/routes/draws.js — sorteio principal (público)
import { Router } from "express";
import { query } from "../db.js";
import {
  ensureMainRaffleCompat,
  fetchCurrentOpenDraw,
  fetchDrawById,
  normalizeMainDrawPayload,
} from "../services/mainRaffleCompat.js";

const router = Router();

const MAIN_DRAW_LIST_SQL = `
  SELECT
    d.id,
    d.status,
    COALESCE(d.title, d.product_name, d.prize_title) AS title,
    COALESCE(d.prize_title, d.title, d.product_name) AS prize,
    COALESCE(d.promo_text, d.banner_title, '') AS promo_text,
    COALESCE(d.banner_title, d.promo_text, '') AS banner_title,
    COALESCE(d.ticket_price_cents, d.price_cents, 5500)::int AS ticket_price_cents,
    COALESCE(d.price_cents, d.ticket_price_cents, 5500)::int AS price_cents,
    COALESCE(d.max_numbers_per_user, 5)::int AS max_numbers_per_user,
    COALESCE(d.cashback_percent, 100)::int AS cashback_percent,
    COALESCE(d.opened_at, d.created_at) AS opened_at,
    d.closed_at,
    d.realized_at,
    d.winner_user_id,
    d.created_at
  FROM public.draws d
`;

// GET /api/draws/current — sorteio aberto atual (fonte da verdade para o front)
router.get("/current", async (_req, res) => {
  try {
    await ensureMainRaffleCompat();
    const draw = await fetchCurrentOpenDraw();

    if (!draw) {
      return res.status(404).json({
        ok: false,
        error: "no_open_draw",
        draw: null,
        current_draw: null,
        currentDraw: null,
      });
    }

    return res.json({
      ok: true,
      draw,
      current_draw: draw,
      currentDraw: draw,
      max_numbers_per_user: draw.max_numbers_per_user,
      ticket_price_cents: draw.ticket_price_cents,
      cashback_percent: draw.cashback_percent,
    });
  } catch (e) {
    console.error("[draws/current] error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "current_draw_failed" });
  }
});

// GET /api/draws — lista (opcional ?status=open|closed)
router.get("/", async (req, res) => {
  try {
    await ensureMainRaffleCompat();

    const qStatus = String(req.query.status || "").toLowerCase().trim();
    let sql = `${MAIN_DRAW_LIST_SQL}`;
    const params = [];

    if (qStatus === "closed" || qStatus === "fechado" || qStatus === "sorteado") {
      sql += `
        WHERE (
          LOWER(COALESCE(d.status, '')) IN ('closed', 'fechado', 'sorteado')
          OR d.closed_at IS NOT NULL
          OR d.realized_at IS NOT NULL
        )
        ORDER BY d.id DESC
      `;
    } else if (qStatus === "open" || qStatus === "aberto") {
      sql += `
        WHERE LOWER(COALESCE(d.status, '')) IN ('open', 'active', 'aberto', 'ativo')
        ORDER BY d.id DESC
      `;
    } else {
      sql += ` ORDER BY d.id ASC `;
    }

    const r = await query(sql, params);
    const draws = (r.rows || []).map(normalizeMainDrawPayload).filter(Boolean);
    const status_by_id = {};
    for (const d of draws) {
      status_by_id[d.id] = d.status;
    }

    const current_draw =
      draws.find((d) => ["open", "active", "aberto", "ativo"].includes(d.status)) || null;

    return res.json({
      ok: true,
      draws,
      status_by_id,
      current_draw,
      currentDraw: current_draw,
      max_numbers_per_user: current_draw?.max_numbers_per_user ?? null,
    });
  } catch (e) {
    console.error("[draws] list error:", e?.message || e);
    return res.status(500).json({ error: "list_failed" });
  }
});

// GET /api/draws/:id — sorteio específico
router.get("/:id(\\d+)", async (req, res) => {
  try {
    await ensureMainRaffleCompat();
    const id = Number(req.params.id);
    const draw = await fetchDrawById(id);

    if (!draw) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }

    return res.json({
      ok: true,
      ...draw,
      draw,
      max_numbers_per_user: draw.max_numbers_per_user,
    });
  } catch (e) {
    console.error("[draws] get error:", e?.message || e);
    return res.status(500).json({ error: "get_failed" });
  }
});

export default router;
