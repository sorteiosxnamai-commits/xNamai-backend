import { Router } from "express";
import {
  getNumbers,
  getPublicDraw,
  listPublicDraws,
  reserveNumbers,
} from "./promotional.service.js";

const router = Router();

function handleError(res, err) {
  const status = err?.status || err?.statusCode || 500;
  if (status >= 500) {
    console.error("[promotional.public]", err);
  }

  return res.status(status).json({
    ok: false,
    error: err?.code || "promotional_error",
    message: err?.message || "Erro no módulo promocional.",
    ...(err?.conflicts && { conflicts: err.conflicts }),
    ...(err?.details && { details: err.details }),
  });
}

router.get("/", async (_req, res) => {
  try {
    const draws = await listPublicDraws();
    return res.json({ ok: true, draws });
  } catch (err) {
    return handleError(res, err);
  }
});

router.get("/:id/numbers", async (req, res) => {
  try {
    const { numbers } = await getNumbers(req.params.id, { requireActive: true });
    return res.json({ ok: true, numbers });
  } catch (err) {
    return handleError(res, err);
  }
});

router.post("/:id/reserve", async (req, res) => {
  try {
    const reservation = await reserveNumbers(req.params.id, req.body || {});
    return res.status(201).json({
      ok: true,
      reservation_id: reservation.id,
      numbers: reservation.numbers,
      expires_at: reservation.expires_at,
    });
  } catch (err) {
    return handleError(res, err);
  }
});

router.get("/:id", async (req, res) => {
  try {
    const draw = await getPublicDraw(req.params.id);
    return res.json({ ok: true, draw });
  } catch (err) {
    return handleError(res, err);
  }
});

export default router;
