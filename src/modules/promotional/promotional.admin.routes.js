import { Router } from "express";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import {
  archiveDraw,
  changeDrawStatus,
  createDraw,
  getAdminDraw,
  getNumbers,
  listAdminDraws,
  listParticipants,
  updateDraw,
  updateNumberStatus,
} from "./promotional.service.js";

const router = Router();

router.use(requireAuth, requireAdmin);

function handleError(res, err) {
  const status = err?.status || err?.statusCode || 500;
  console.error("[PROMOTIONAL_ERROR]", {
    code: err?.code,
    message: err?.message,
    detail: err?.detail,
    hint: err?.hint,
    stack: err?.stack,
  });

  if (status >= 500) {
    return res.status(500).json({
      ok: false,
      error: "Erro ao carregar campanhas promocionais",
      code: err?.code || "PROMOTIONAL_ERROR",
    });
  }

  return res.status(status).json({
    ok: false,
    error: err?.code || "promotional_admin_error",
    message: err?.message || "Erro no módulo promocional.",
    ...(err?.conflicts && { conflicts: err.conflicts }),
    ...(err?.details && { details: err.details }),
  });
}

router.get("/draws", async (_req, res) => {
  try {
    const draws = await listAdminDraws();
    return res.json({ ok: true, draws });
  } catch (err) {
    return handleError(res, err);
  }
});

router.post("/draws", async (req, res) => {
  try {
    const draw = await createDraw(req.body || {});
    return res.status(201).json({
      ok: true,
      draw_id: draw.id,
      draw,
    });
  } catch (err) {
    return handleError(res, err);
  }
});

router.get("/draws/:id/numbers", async (req, res) => {
  try {
    const { numbers } = await getNumbers(req.params.id);
    return res.json({ ok: true, numbers });
  } catch (err) {
    return handleError(res, err);
  }
});

router.patch("/draws/:id/numbers/:number", async (req, res) => {
  try {
    const number = await updateNumberStatus(
      req.params.id,
      req.params.number,
      req.body?.status
    );
    return res.json({ ok: true, number });
  } catch (err) {
    return handleError(res, err);
  }
});

router.get("/draws/:id/participants", async (req, res) => {
  try {
    const participants = await listParticipants(req.params.id);
    return res.json({ ok: true, participants });
  } catch (err) {
    return handleError(res, err);
  }
});

router.patch("/draws/:id/status", async (req, res) => {
  try {
    const draw = await changeDrawStatus(req.params.id, req.body?.status);
    return res.json({ ok: true, draw });
  } catch (err) {
    return handleError(res, err);
  }
});

router.get("/draws/:id", async (req, res) => {
  try {
    const draw = await getAdminDraw(req.params.id);
    return res.json({ ok: true, draw });
  } catch (err) {
    return handleError(res, err);
  }
});

router.put("/draws/:id", async (req, res) => {
  try {
    const draw = await updateDraw(req.params.id, req.body || {});
    return res.json({ ok: true, draw });
  } catch (err) {
    return handleError(res, err);
  }
});

router.delete("/draws/:id", async (req, res) => {
  try {
    const draw = await archiveDraw(req.params.id);
    return res.json({ ok: true, draw });
  } catch (err) {
    return handleError(res, err);
  }
});

export default router;
