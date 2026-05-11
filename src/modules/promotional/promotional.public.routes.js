import { Router } from "express";
import jwt from "jsonwebtoken";
import { requireAuth } from "../../middleware/auth.js";
import {
  getNumbers,
  getPublicDraw,
  listMyParticipations,
  listPublicDraws,
  reserveNumbers,
} from "./promotional.service.js";

const router = Router();

const JWT_SECRET =
  process.env.JWT_SECRET ||
  process.env.JWT_SECRET_KEY ||
  process.env.SUPABASE_JWT_SECRET ||
  "change-me-in-env";

function optionalAuth(req, res, next) {
  const auth = req.headers?.authorization || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);

  if (!match) return next();

  try {
    const payload = jwt.verify(match[1].trim(), JWT_SECRET);
    req.user = {
      id: payload.id || payload.sub,
      email: payload.email || payload.user?.email,
      name: payload.name || payload.user?.name,
      phone: payload.phone || payload.user?.phone,
      role: payload.role || payload.user?.role,
      ...payload,
    };
    return next();
  } catch (err) {
    return res.status(401).json({
      ok: false,
      error: "Token inválido.",
      code: "unauthorized",
    });
  }
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

function handleError(res, err, options = {}) {
  const status = err?.status || err?.statusCode || 500;
  const tag = options.tag || "[PROMOTIONAL_ERROR]";
  logPromotionalError(tag, err);

  if (status >= 500) {
    return res.status(500).json({
      ok: false,
      error: options.error || "Erro ao carregar campanhas promocionais",
      code: options.code || err?.code || "PROMOTIONAL_ERROR",
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

router.post("/:id/reserve", optionalAuth, async (req, res) => {
  try {
    const reservation = await reserveNumbers(req.params.id, req.body || {}, req.user || null);
    return res.status(201).json({
      ok: true,
      reservation_id: reservation.id,
      numbers: reservation.numbers,
      message: "Números promocionais reservados com sucesso.",
    });
  } catch (err) {
    return handleError(res, err, {
      tag: "[PROMOTIONAL_RESERVE_ERROR]",
      error: "Erro ao processar participação promocional.",
      code: "PROMOTIONAL_RESERVE_ERROR",
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
