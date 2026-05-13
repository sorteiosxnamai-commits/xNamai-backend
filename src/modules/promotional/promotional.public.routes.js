import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
  createPromotionalPix,
  getNumbers,
  getPublicDraw,
  listMyParticipations,
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
        error: "Entre ou crie uma conta para reservar números promocionais.",
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
  console.error(tag, {
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
  const status = err?.status || err?.statusCode || 500;
  const tag = options.tag || "[PROMOTIONAL_ERROR]";
  logPromotionalError(tag, err);

  if (status >= 500) {
    if (options.code === "PROMOTIONAL_RESERVE_ERROR") {
      return res.status(500).json({
        ok: false,
        error: "Erro ao processar número promocional.",
      });
    }
    return res.status(500).json({
      ok: false,
      error: options.error || "Erro ao carregar campanhas promocionais",
      code: options.code || err?.code || "PROMOTIONAL_ERROR",
    });
  }

  if (options.code === "PROMOTIONAL_RESERVE_ERROR") {
    if (status === 409) {
      return res.status(409).json({
        ok: false,
        error: "Um ou mais números já estão indisponíveis.",
      });
    }

    if (status === 401) {
      return res.status(401).json({
        ok: false,
        error: err?.message || "Usuário não autenticado.",
      });
    }

    return res.status(status).json({
      ok: false,
      error: err?.message || "Erro ao reservar números promocionais.",
      ...(err?.conflicts && { conflicts: err.conflicts }),
    });
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

router.get("/me/participations", requireAuth, async (req, res) => {
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

router.get("/:id/numbers", async (req, res) => {
  try {
    const { numbers } = await getNumbers(req.params.id, { requireActive: true });
    return res.json({ ok: true, numbers });
  } catch (err) {
    return handleError(res, err);
  }
});

router.post("/:id/reserve", requirePromotionalAuth, async (req, res) => {
  try {
    const reservation = await reserveNumbers(req.params.id, req.body || {}, req.user);
    return res.status(201).json({
      ok: true,
      reservation_id: reservation.id,
      draw_id: Number(req.params.id),
      user_id: reservation.user_id,
      buyer_email: reservation.buyer_email,
      numbers: reservation.numbers,
      payment_status: reservation.payment_status || "pending",
      status: reservation.status || "reserved",
      can_pay: true,
      message: "Números promocionais reservados com sucesso.",
    });
  } catch (err) {
    return handleError(res, err, {
      tag: "[PROMOTIONAL_RESERVE_ERROR]",
      error: "Erro ao processar número promocional.",
      code: "PROMOTIONAL_RESERVE_ERROR",
    });
  }
});

router.post("/:drawId/reservations/:reservationId/pix", requireAuth, async (req, res) => {
  try {
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
    logPromotionalError("[PROMOTIONAL_PIX_ERROR]", err);

    if (err?.status === 403) {
      return res.status(403).json({
        ok: false,
        error: "Você não tem permissão para pagar esta reserva.",
      });
    }

    const status = err?.status && err.status < 500 ? err.status : 500;

    return res.status(status).json({
      ok: false,
      error: err?.message || "Erro ao gerar PIX promocional.",
      ...(status >= 500 ? {} : { code: err?.code || "PROMOTIONAL_PIX_ERROR" }),
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
