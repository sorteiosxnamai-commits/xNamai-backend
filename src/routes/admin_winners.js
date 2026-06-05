// backend/src/routes/admin_winners.js
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

const router = Router();

const norm = (v, max = 2048) => String(v ?? "").trim().slice(0, max);

const normWinnerName = (v) => {
  if (v == null) return null;
  const text = String(v).trim();
  return !text || text === "-" ? null : text;
};

const normWinnerNumber = (v) => {
  if (v == null) return null;
  const text = String(v).trim();
  if (!text || text === "-") return null;
  if (!/^\d+$/.test(text)) return undefined;

  const n = Number(text);
  if (!Number.isInteger(n) || n < 0 || n > 99) return undefined;

  return n;
};

/**
 * GET /api/admin/winners
 * Lista sorteios realizados/fechados.
 *
 * Ajuste mínimo:
 * antes dependia apenas de realized_at;
 * no XNamai muitos sorteios têm closed_at preenchido e realized_at null.
 */
router.get("/", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const r = await query(
      `
      SELECT
        d.id AS draw_id,
        COALESCE(NULLIF(d.winner_name, ''), u.name, u.email, '-') AS winner_name,
        d.winner_number,
        COALESCE(d.realized_at, d.result_at, d.closed_at) AS realized_at,
        d.closed_at,
        d.product_name,
        d.product_link
      FROM public.draws d
      LEFT JOIN public.users u
        ON u.id::bigint = d.winner_user_id::bigint
      WHERE
        COALESCE(d.realized_at, d.result_at, d.closed_at) IS NOT NULL
        OR LOWER(COALESCE(d.status, '')) IN ('closed', 'encerrado', 'finalizado')
      ORDER BY
        COALESCE(d.realized_at, d.result_at, d.closed_at, d.opened_at, d.created_at) DESC NULLS LAST,
        d.id DESC
      `
    );

    const now = Date.now();

    const winners = (r.rows || []).map((row) => {
      const realized = row.realized_at ? new Date(row.realized_at) : null;

      const daysSince = realized
        ? Math.max(0, Math.floor((now - realized.getTime()) / 86400000))
        : 0;

      const redeemed = !!row.closed_at;

      return {
        draw_id: row.draw_id,
        winner_name: row.winner_name || "-",
        winner_number: row.winner_number ?? null,
        realized_at: row.realized_at,
        closed_at: row.closed_at,
        product_name: row.product_name || "",
        product_link: row.product_link || "",
        redeemed,
        status: redeemed ? "RESGATADO" : "NÃO RESGATADO",
        days_since: daysSince,
      };
    });

    return res.json({
      ok: true,
      winners,
      data: winners,
    });
  } catch (e) {
    console.error("[admin/winners] error:", e);
    return res.status(500).json({ error: "list_failed" });
  }
});

/**
 * PATCH /api/admin/winners/:id
 * body: { winner_name?, winner_number?, product_name?, product_link? }
 */
router.patch("/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { winner_name, winner_number, product_name, product_link } = req.body || {};

    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "invalid_id" });
    }

    const normalizedWinnerName = normWinnerName(winner_name);
    const normalizedWinnerNumber = normWinnerNumber(winner_number);

    if (normalizedWinnerNumber === undefined) {
      return res.status(400).json({ ok: false, error: "invalid_winner_number" });
    }

    const { rows } = await query(
      `
      UPDATE public.draws
         SET product_name = COALESCE($2, product_name),
             product_link = COALESCE($3, product_link),
             winner_name = $4,
             winner_number = $5,
             updated_at = NOW()
       WHERE id = $1
       RETURNING id, winner_name, winner_number, product_name, product_link
      `,
      [
        id,
        product_name != null ? norm(product_name, 255) : null,
        product_link != null ? norm(product_link, 2048) : null,
        normalizedWinnerName,
        normalizedWinnerNumber,
      ]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "not_found" });
    }

    return res.json({
      ok: true,
      draw_id: rows[0].id,
      winner_name: rows[0].winner_name || "",
      winner_number: rows[0].winner_number ?? null,
      product_name: rows[0].product_name || "",
      product_link: rows[0].product_link || "",
    });
  } catch (e) {
    console.error("[admin/winners PATCH] error:", e);
    return res.status(500).json({ error: "update_failed" });
  }
});

export default router;
