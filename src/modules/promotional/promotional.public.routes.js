import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
  getNumbers,
  getPromotionalAssignmentForUser,
  getPublicDraw,
  listMyParticipations,
  listMyReservations,
  listPublicDraws,
} from "./promotional.service.js";

const router = Router();

const PUBLIC_PURCHASE_DISABLED_MESSAGE =
  "Este sorteio promocional não permite compra pelo site. O número deve ser atribuído pelo administrador.";

function respondPublicPurchaseDisabled(res) {
  return res.status(403).json({
    ok: false,
    code: "promotional_public_purchase_disabled",
    error: "promotional_public_purchase_disabled",
    message: PUBLIC_PURCHASE_DISABLED_MESSAGE,
  });
}

function requirePromotionalAuth(req, res, next) {
  const originalStatus = res.status.bind(res);
  const originalJson = res.json.bind(res);
  let statusCode = 200;

  function restore() {
    res.status = originalStatus;
    res.json = originalJson;
  }

  res.status = (code) => {
    statusCode = code;
    return res;
  };

  res.json = (payload) => {
    restore();
    if (statusCode === 401) {
      return originalStatus(401).json({
        ok: false,
        error: "login_required",
        message: "Entre ou crie uma conta para reservar números promocionais.",
      });
    }
    return originalStatus(statusCode).json(payload);
  };

  return requireAuth(req, res, (err) => {
    restore();
    return next(err);
  });
}

function logPromotionalError(tag, err) {
  console.error("[promotional] error:", {
    tag,
    code: err?.code,
    message: err?.message,
    detail: err?.detail,
    hint: err?.hint,
    stack: err?.stack,
  });
}

function handleError(res, err, options = {}) {
  const isUnavailable = [
    "PROMOTIONAL_NUMBER_ALREADY_RESERVED",
    "promotional_numbers_unavailable",
    "number_unavailable",
  ].includes(err?.code);
  const status = isUnavailable ? (err?.status || err?.statusCode || 409) : (err?.status || err?.statusCode || 500);
  const tag = options.tag || "[PROMOTIONAL_ERROR]";
  const responseCode = isUnavailable
    ? "PROMOTIONAL_NUMBER_ALREADY_RESERVED"
    : err?.code === "validation_error"
      ? "invalid_number"
      : (err?.code || "promotional_error");
  logPromotionalError(tag, err);

  if (status >= 500) {
    return res.status(500).json({
      ok: false,
      code: "unexpected_error",
      message: "Erro inesperado ao processar a solicitação.",
      ...(err?.detail && { detail: err.detail }),
      ...(err?.hint && { hint: err.hint }),
      ...(err?.constraint && { constraint: err.constraint }),
    });
  }

  return res.status(status).json({
    ok: false,
    code: responseCode,
    error: responseCode,
    message: err?.message || "Erro no módulo promocional.",
    ...(err?.conflicts && { conflicts: err.conflicts }),
    ...(err?.details && { details: err.details }),
    ...(err?.detail && { detail: err.detail }),
    ...(err?.hint && { hint: err.hint }),
    ...(err?.constraint && { constraint: err.constraint }),
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

router.get("/me/participations", requirePromotionalAuth, async (req, res) => {
  try {
    const participations = await listMyParticipations(req.user);
    return res.json({ ok: true, participations });
  } catch (err) {
    return handleError(res, err, {
      tag: "[PROMOTIONAL_PARTICIPATIONS_ERROR]",
      error: "Erro ao processar participação promocional.",
      code: "PROMOTIONAL_PARTICIPATIONS_ERROR",
    });
  }
});

router.get("/me/reservations", requirePromotionalAuth, async (req, res) => {
  try {
    const items = await listMyReservations(req.user);
    return res.json({ ok: true, items });
  } catch (err) {
    return handleError(res, err, {
      tag: "[PROMOTIONAL_MY_RESERVATIONS_ERROR]",
    });
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

async function createReservationHandler(req, res) {
  return respondPublicPurchaseDisabled(res);
}

router.post("/:drawId/reservations", requirePromotionalAuth, createReservationHandler);

router.post("/:id/reserve", requirePromotionalAuth, createReservationHandler);

router.post("/:drawId/checkout", requirePromotionalAuth, (req, res) => {
  return respondPublicPurchaseDisabled(res);
});

router.post("/:drawId/reservations/:reservationId/pix", requirePromotionalAuth, (req, res) => {
  return respondPublicPurchaseDisabled(res);
});

router.post("/reservations/:reservationId/pix", requirePromotionalAuth, (req, res) => {
  return respondPublicPurchaseDisabled(res);
});

router.get("/:drawId/my-assignment", requirePromotionalAuth, async (req, res) => {
  try {
    const drawId = Number.parseInt(req.params.drawId, 10);
    if (!Number.isInteger(drawId) || drawId <= 0) {
      return res.status(400).json({
        ok: false,
        code: "invalid_promotional_draw",
        message: "ID do sorteio promocional inválido.",
      });
    }

    const assignment = await getPromotionalAssignmentForUser(drawId, req.user);
    return res.json({ ok: true, ...assignment });
  } catch (err) {
    return handleError(res, err, { tag: "[PROMOTIONAL_MY_ASSIGNMENT_ERROR]" });
  }
});

router.post("/:drawId/redeem", requirePromotionalAuth, async (req, res) => {
  try {
    const drawId = Number.parseInt(req.params.drawId, 10);
    if (!Number.isInteger(drawId) || drawId <= 0) {
      return res.status(400).json({
        ok: false,
        code: "invalid_promotional_draw",
        message: "ID do sorteio promocional inválido.",
      });
    }

    const assignment = await getPromotionalAssignmentForUser(drawId, req.user);
    if (!assignment.has_assignment) {
      return res.status(404).json({
        ok: false,
        code: "promotional_assignment_not_found",
        error: "promotional_assignment_not_found",
        message: "Você ainda não possui número atribuído neste sorteio promocional.",
      });
    }

    return res.json({
      ok: true,
      redeemed: true,
      ...assignment,
    });
  } catch (err) {
    return handleError(res, err, { tag: "[PROMOTIONAL_REDEEM_ERROR]" });
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
