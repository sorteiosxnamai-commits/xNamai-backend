// src/routes/config.js
import { Router } from "express";
import {
  getTicketPriceCents,
  setTicketPriceCents,
  getBannerTitle,
  setBannerTitle,
  getMaxNumbersPerSelection,
  setMaxNumbersPerSelection,
} from "../services/config.js";
import { fetchCurrentOpenDraw } from "../services/mainRaffleCompat.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

const router = Router();

/**
 * GET /api/config
 * Retorna as chaves públicas usadas no front.
 */
router.get("/", async (_req, res) => {
  try {
    const currentDraw = await fetchCurrentOpenDraw();
    const [fallbackPrice, banner_title, fallbackMaxSelection] = await Promise.all([
      getTicketPriceCents(),
      getBannerTitle(),
      getMaxNumbersPerSelection(),
    ]);

    const ticket_price_cents =
      currentDraw?.ticket_price_cents ?? fallbackPrice;
    const max_numbers_per_user = Number(
      currentDraw?.max_numbers_per_user ?? fallbackMaxSelection ?? 5
    );

    res.json({
      ok: true,
      ticket_price_cents,
      price_cents: currentDraw?.price_cents ?? ticket_price_cents,
      banner_title: currentDraw?.banner_title || banner_title,
      promo_text: currentDraw?.promo_text || "",
      max_numbers_per_user,
      max_numbers_per_selection: max_numbers_per_user,
      cashback_percent: Number(currentDraw?.cashback_percent ?? 100),
      draw_id: currentDraw?.id ?? null,
      current_draw: currentDraw,
      currentDraw: currentDraw,
    });
  } catch (e) {
    console.error("[config][GET] error", e);
    res.status(500).json({ error: "config_failed" });
  }
});

/**
 * POST /api/config
 * Atualiza banner_title e max_numbers_per_selection (e opcionalmente price_cents).
 * O preço você já atualiza pela rota antiga; aqui deixo suportado também.
 */
router.post("/", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { banner_title, max_numbers_per_selection, ticket_price_cents } = req.body || {};

    if (banner_title !== undefined) {
      await setBannerTitle(banner_title);
    }
    if (max_numbers_per_selection !== undefined) {
      await setMaxNumbersPerSelection(max_numbers_per_selection);
    }
    if (ticket_price_cents !== undefined) {
      await setTicketPriceCents(ticket_price_cents);
    }

    const payload = {
      ticket_price_cents: await getTicketPriceCents(),
      banner_title: await getBannerTitle(),
      max_numbers_per_selection: await getMaxNumbersPerSelection(),
    };

    res.json({ ok: true, ...payload });
  } catch (e) {
    console.error("[config][POST] error", e);
    res.status(500).json({ error: "config_update_failed" });
  }
});

export default router;
