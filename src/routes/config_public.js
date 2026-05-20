import { Router } from "express";
import { fetchCurrentOpenDraw } from "../services/mainRaffleCompat.js";

const router = Router();

// GET /api/config/public — config do sorteio atual (sem auth)
router.get("/", async (_req, res) => {
  try {
    const draw = await fetchCurrentOpenDraw();

    if (!draw) {
      return res.status(404).json({
        ok: false,
        error: "no_open_draw",
        ticket_price_cents: null,
        max_numbers_per_user: null,
      });
    }

    return res.json({
      ok: true,
      ticket_price_cents: draw.ticket_price_cents,
      price_cents: draw.price_cents,
      max_numbers_per_user: draw.max_numbers_per_user,
      max_numbers_per_selection: draw.max_numbers_per_user,
      cashback_percent: draw.cashback_percent,
      draw_id: draw.id,
      current_draw: draw,
      currentDraw: draw,
    });
  } catch (e) {
    console.error("[config/public] error:", e?.message || e);
    return res.status(500).json({ error: "config_public_failed" });
  }
});

export default router;
