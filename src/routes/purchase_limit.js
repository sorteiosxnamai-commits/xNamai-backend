// backend/src/routes/purchase_limit.js
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { checkPurchaseLimit } from "../services/purchase_limit.js";

const router = Router();

async function getCurrentOpenDrawId() {
  const { rows } = await query(`
    SELECT id
      FROM public.draws
     WHERE LOWER(COALESCE(status, '')) IN ('open', 'active', 'aberto', 'ativo')
     ORDER BY id DESC
     LIMIT 1
  `);
  return rows?.[0]?.id ?? null;
}

function parseAdd(raw) {
  const add = parseInt(String(raw ?? "0"), 10);
  if (!Number.isFinite(add) || add < 0) return 0;
  return add;
}

router.get("/check", requireAuth, async (req, res) => {
  try {
    const add = parseAdd(req.query.add);
    let drawId = req.query.draw_id ? Number(req.query.draw_id) : null;
    if (!drawId) drawId = await getCurrentOpenDrawId();
    if (!drawId) return res.status(404).json({ ok: false, error: "no_open_draw" });

    const out = await checkPurchaseLimit(req.user.id, drawId, add);
    return res.json(out);
  } catch (e) {
    console.error("[purchase-limit][GET] error:", e);
    const status = e.status || 500;
    return res.status(status).json({
      ok: false,
      error: e.message || "purchase_limit_error",
    });
  }
});

router.post("/check", requireAuth, async (req, res) => {
  try {
    const add = parseAdd(req.body?.add);
    let drawId = req.body?.draw_id ? Number(req.body.draw_id) : null;
    if (!drawId) drawId = await getCurrentOpenDrawId();
    if (!drawId) return res.status(404).json({ ok: false, error: "no_open_draw" });

    const out = await checkPurchaseLimit(req.user.id, drawId, add);
    return res.json(out);
  } catch (e) {
    console.error("[purchase-limit][POST] error:", e);
    const status = e.status || 500;
    return res.status(status).json({
      ok: false,
      error: e.message || "purchase_limit_error",
    });
  }
});

export default router;
