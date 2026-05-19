import { Router } from "express";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import {
  archiveDraw,
  assignNumbersToUser,
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

function handleError(res, err, options = {}) {
  const status = Number(err?.status || err?.statusCode || 500);
  const logTag = options.logTag || "[PROMOTIONAL_ADMIN_ERROR]";

  const debug = {
    code: err?.code || null,
    message: err?.message || null,
    detail: err?.detail || null,
    hint: err?.hint || null,
    constraint: err?.constraint || null,
    table: err?.table || null,
    column: err?.column || null,
    routine: err?.routine || null,
  };

  console.error(logTag, {
    ...debug,
    stack: err?.stack,
  });

  return res.status(status >= 400 && status < 600 ? status : 500).json({
    ok: false,
    error: options.friendlyError || err?.message || "Erro no módulo promocional admin.",
    code: err?.code || "promotional_admin_error",
    debug,
    ...(err?.conflicts && { conflicts: err.conflicts }),
    ...(err?.details && { details: err.details }),
  });
}

router.get("/draws", async (_req, res) => {
  try {
    const draws = await listAdminDraws();
    return res.json({ ok: true, draws });
  } catch (err) {
    return handleError(res, err, {
      logTag: "[PROMOTIONAL_ADMIN_DRAWS_LIST_ERROR]",
      friendlyError: "Erro ao carregar campanhas promocionais.",
    });
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
    return handleError(res, err, {
      logTag: "[PROMOTIONAL_ADMIN_DRAWS_CREATE_ERROR]",
      friendlyError: "Erro ao criar campanha promocional.",
    });
  }
});

router.get("/draws/:id/numbers", async (req, res) => {
  try {
    const { numbers } = await getNumbers(req.params.id);
    return res.json({ ok: true, numbers });
  } catch (err) {
    return handleError(res, err, {
      logTag: "[PROMOTIONAL_ADMIN_NUMBERS_ERROR]",
      friendlyError: "Erro ao processar número promocional.",
    });
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
    return handleError(res, err, {
      logTag: "[PROMOTIONAL_ADMIN_NUMBERS_ERROR]",
      friendlyError: "Erro ao processar número promocional.",
    });
  }
});

router.post("/draws/:id/assign-numbers", async (req, res) => {
  try {
    const result = await assignNumbersToUser(req.params.id, req.body || {});
    return res.status(201).json({
      ok: true,
      ...result,
    });
  } catch (err) {
    return handleError(res, err, {
      logTag: "[PROMOTIONAL_ADMIN_ASSIGN_NUMBERS_ERROR]",
      friendlyError: "Erro ao atribuir número promocional.",
    });
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
