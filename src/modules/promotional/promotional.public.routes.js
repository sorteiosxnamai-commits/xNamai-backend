import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
  createPromotionalPix,
  getNumbers,
  getPublicDraw,
  listMyParticipations,
  listMyReservations,
  listPublicDraws,
  reserveNumbers,
} from "./promotional.service.js";

const router = Router();

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

function getBaseUrl(req) {
  const publicUrl = process.env.PUBLIC_URL ? String(process.env.PUBLIC_URL).replace(/\/$/, "") : "";
  if (publicUrl) return publicUrl;

  const protoRaw = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const proto = String(protoRaw).split(",")[0].trim() || "https";
  const host = req.get("host");
  let baseUrl = `${proto}://${host}`.replace(/\/$/, "");
  if (process.env.NODE_ENV === "production" && !baseUrl.startsWith("https://")) {
    baseUrl = baseUrl.replace(/^http:\/\//, "https://");
  }
  return baseUrl;
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
    });
  }

  return res.status(status).json({
    ok: false,
    code: responseCode,
    error: responseCode,
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

function sendReservationCreated(res, reservation) {
  const amountCents = Number(reservation.amount_cents || reservation.total_cents || 0);
  const numbers = Array.isArray(reservation.numbers)
    ? reservation.numbers.map((n) => Number(n))
    : [];
  const reservationId = reservation.id || reservation.reservation_id;
  const drawId = Number(reservation.draw_id);
  const status = reservation.status || "reserved";
  const paymentStatus = reservation.payment_status || "pending";
  const canPay = reservation.can_pay ?? (
    String(paymentStatus).toLowerCase() === "pending" &&
    String(status).toLowerCase() === "reserved"
  );

  return res.status(201).json({
    ok: true,
    success: true,
    reservation_id: reservationId,
    draw_id: drawId,
    numbers,
    amount_cents: amountCents,
    expires_at: reservation.expires_at || null,
    status,
    payment_status: paymentStatus,
    can_pay: canPay,
    canPay,
    reservation: {
      reservation_id: reservationId,
      id: reservationId,
      draw_id: drawId,
      numbers,
      status,
      payment_status: paymentStatus,
      price_cents: Number(reservation.price_cents || 0),
      amount_cents: amountCents,
      total_cents: amountCents,
      expires_at: reservation.expires_at || null,
      can_pay: canPay,
      canPay,
      type: "promotional",
    },
    message: "Números promocionais reservados com sucesso.",
  });
}

async function createReservationHandler(req, res) {
  const drawId = req.params.drawId || req.params.id;
  const numbers = Array.isArray(req.body?.numbers)
    ? req.body.numbers
    : Array.isArray(req.body?.selectedNumbers)
      ? req.body.selectedNumbers
      : [];
  const userId = req.user?.id;

  try {
    const reservation = await reserveNumbers(drawId, { ...(req.body || {}), numbers }, req.user);
    console.log("[PROMOTIONAL_RESERVATION_CREATE]", {
      reservationId: reservation.id || reservation.reservation_id,
      drawId,
      userId,
      numbers: reservation.numbers,
      amount_cents: reservation.amount_cents || reservation.total_cents || 0,
    });
    return sendReservationCreated(res, reservation);
  } catch (err) {
    console.error("[PROMOTIONAL_RESERVATION_ERROR]", {
      message: err?.message,
      code: err?.code,
      stack: err?.stack,
      drawId,
      userId,
      numbers,
    });
    console.error("[promotional.reserve] error", {
      message: err?.message,
      code: err?.code,
      stack: err?.stack,
      drawId,
      userId,
      numbers,
    });

    return handleError(res, err, {
      tag: "[PROMOTIONAL_RESERVE_ERROR]",
    });
  }
}

router.post("/:drawId/reservations", requirePromotionalAuth, createReservationHandler);

router.post("/:id/reserve", requirePromotionalAuth, createReservationHandler);

router.post("/:drawId/reservations/:reservationId/pix", requirePromotionalAuth, async (req, res) => {
  try {
    console.log("[PROMOTIONAL_PIX_CREATE]", {
      drawId: req.params.drawId,
      reservationId: req.params.reservationId,
      userId: req.user?.id,
    });
    const pix = await createPromotionalPix(
      req.params.drawId,
      req.params.reservationId,
      req.user,
      {
        notification_url: `${getBaseUrl(req)}/api/payments/webhook/mercadopago`,
      }
    );
    return res.json(pix);
  } catch (err) {
    console.error("[PROMOTIONAL_PIX_ERROR]", {
      message: err?.message,
      code: err?.code,
      detail: err?.detail,
      stack: err?.stack,
      drawId: req.params.drawId,
      reservationId: req.params.reservationId,
      userId: req.user?.id,
    });
    return handleError(res, err, {
      tag: "[PROMOTIONAL_PIX_ERROR]",
    });
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
