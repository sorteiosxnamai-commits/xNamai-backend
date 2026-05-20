import { Router } from "express";
import jwt from "jsonwebtoken";
import { requireAuth } from "../../middleware/auth.js";
import {
  claimNumbers,
  getMyAllowance,
  getPromotionalAssignmentForUser,
  getPublicDraw,
  getPublicNumbersGrid,
  listMyParticipations,
  listMyReservations,
  listPublicDraws,
} from "./promotional.service.js";

const router = Router();

const PUBLIC_PURCHASE_DISABLED_MESSAGE =
  "Este sorteio promocional não permite compra pelo site. Os números precisam ser liberados pelo administrador.";

function respondPublicPurchaseDisabled(res) {
  return res.status(403).json({
    ok: false,
    code: "promotional_public_purchase_disabled",
    error: "promotional_public_purchase_disabled",
    message: PUBLIC_PURCHASE_DISABLED_MESSAGE,
  });
}

const JWT_SECRET =
  process.env.JWT_SECRET ||
  process.env.JWT_SECRET_KEY ||
  process.env.SUPABASE_JWT_SECRET ||
  "change-me-in-env";

function extractOptionalToken(req) {
  const auth = req.headers?.authorization;
  if (auth) {
    const raw = String(auth).trim().replace(/^Bearer\s+/i, "").trim();
    if (raw) return raw;
  }

  const cookies = req.cookies || {};
  for (const name of ["ns_auth", "ns_auth_token", "token", "jwt"]) {
    if (cookies[name]) return String(cookies[name]).trim();
  }

  return null;
}

function optionalPromotionalAuth(req, _res, next) {
  try {
    const token = extractOptionalToken(req);
    if (token) {
      const payload = jwt.verify(token, JWT_SECRET);
      req.user = {
        id: payload.id || payload.sub,
        email: payload.email || payload.user?.email,
        role: payload.role || payload.user?.role,
        name: payload.name || payload.nome,
        phone: payload.phone,
        ...payload,
      };
    }
  } catch {
    // visitante anônimo
  }
  return next();
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
        message: "Entre ou crie uma conta para participar do sorteio promocional.",
      });
    }
    return originalStatus(statusCode).json(payload);
  };

  return requireAuth(req, res, (err) => {
    restore();
    return next(err);
  });
}

function logAllowanceError(err) {
  console.error("[PROMOTIONAL_ALLOWANCE_ERROR]", {
    message: err?.message,
    code: err?.code,
    detail: err?.detail,
    hint: err?.hint,
    table: err?.table,
    column: err?.column,
    constraint: err?.constraint,
    stack: err?.stack,
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
  const conflictCodes = [
    "PROMOTIONAL_NUMBER_ALREADY_RESERVED",
    "promotional_numbers_unavailable",
    "promotional_number_unavailable",
    "number_unavailable",
    "promotional_allowance_limit_exceeded",
  ];
  const isUnavailable = conflictCodes.includes(err?.code);
  const status = isUnavailable ? (err?.status || err?.statusCode || 409) : (err?.status || err?.statusCode || 500);
  const tag = options.tag || "[PROMOTIONAL_ERROR]";
  const responseCode = isUnavailable && err?.code === "promotional_allowance_limit_exceeded"
    ? "promotional_allowance_limit_exceeded"
    : isUnavailable && ["promotional_number_unavailable", "number_unavailable"].includes(err?.code)
      ? "promotional_number_unavailable"
      : isUnavailable
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

function parseDrawId(req) {
  return Number.parseInt(req.params.drawId || req.params.id, 10);
}

function normalizeClaimNumbers(body = {}) {
  const raw = body.numbers ?? body.selectedNumbers ?? body.number ?? [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .map((value) => Number.parseInt(String(value).trim(), 10))
    .filter((value) => Number.isInteger(value) && value >= 0 && value <= 99);
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

async function publicNumbersHandler(req, res) {
  try {
    const drawId = parseDrawId(req);
    if (!Number.isInteger(drawId) || drawId <= 0) {
      return res.status(400).json({
        ok: false,
        code: "invalid_promotional_draw",
        message: "ID do sorteio promocional inválido.",
      });
    }

    const user = req.user?.id ? req.user : null;
    const payload = await getPublicNumbersGrid(drawId, user);
    return res.json({ ok: true, ...payload });
  } catch (err) {
    logAllowanceError(err);
    return handleError(res, err, { tag: "[PROMOTIONAL_PUBLIC_NUMBERS_ERROR]" });
  }
}

router.get("/:drawId/numbers", optionalPromotionalAuth, publicNumbersHandler);
router.get("/:id/numbers", optionalPromotionalAuth, publicNumbersHandler);

router.get("/:drawId/my-allowance", requirePromotionalAuth, async (req, res) => {
  try {
    const drawId = parseDrawId(req);
    if (!Number.isInteger(drawId) || drawId <= 0) {
      return res.status(400).json({
        ok: false,
        code: "invalid_promotional_draw",
        message: "ID do sorteio promocional inválido.",
      });
    }

    const allowance = await getMyAllowance(drawId, req.user);
    return res.json({ ok: true, ...allowance });
  } catch (err) {
    logAllowanceError(err);
    return handleError(res, err, { tag: "[PROMOTIONAL_MY_ALLOWANCE_ERROR]" });
  }
});

router.post("/:drawId/claim-numbers", requirePromotionalAuth, async (req, res) => {
  try {
    const drawId = parseDrawId(req);
    if (!Number.isInteger(drawId) || drawId <= 0) {
      return res.status(400).json({
        ok: false,
        code: "invalid_promotional_draw",
        message: "ID do sorteio promocional inválido.",
      });
    }

    const numbers = normalizeClaimNumbers(req.body);
    if (!numbers.length) {
      return res.status(400).json({
        ok: false,
        code: "no_numbers",
        message: "Nenhum número selecionado.",
      });
    }

    const result = await claimNumbers(drawId, numbers, req.user);
    return res.status(201).json(result);
  } catch (err) {
    logAllowanceError(err);
    return handleError(res, err, { tag: "[PROMOTIONAL_CLAIM_NUMBERS_ERROR]" });
  }
});

async function createReservationHandler(_req, res) {
  return respondPublicPurchaseDisabled(res);
}

router.post("/:drawId/reservations", requirePromotionalAuth, createReservationHandler);
router.post("/:id/reserve", requirePromotionalAuth, createReservationHandler);
router.post("/:drawId/checkout", requirePromotionalAuth, createReservationHandler);
router.post("/:drawId/reservations/:reservationId/pix", requirePromotionalAuth, createReservationHandler);
router.post("/reservations/:reservationId/pix", requirePromotionalAuth, createReservationHandler);

router.get("/:drawId/my-assignment", requirePromotionalAuth, async (req, res) => {
  try {
    const drawId = parseDrawId(req);
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
    logAllowanceError(err);
    return handleError(res, err, { tag: "[PROMOTIONAL_MY_ASSIGNMENT_ERROR]" });
  }
});

router.post("/:drawId/redeem", requirePromotionalAuth, async (req, res) => {
  try {
    const drawId = parseDrawId(req);
    if (!Number.isInteger(drawId) || drawId <= 0) {
      return res.status(400).json({
        ok: false,
        code: "invalid_promotional_draw",
        message: "ID do sorteio promocional inválido.",
      });
    }

    const assignment = await getPromotionalAssignmentForUser(drawId, req.user);
    if (!assignment.has_allowance && !assignment.has_assignment) {
      return res.status(404).json({
        ok: false,
        code: "promotional_assignment_not_found",
        error: "promotional_assignment_not_found",
        message: "Você ainda não possui números liberados neste sorteio promocional.",
      });
    }

    return res.json({
      ok: true,
      redeemed: true,
      ...assignment,
    });
  } catch (err) {
    logAllowanceError(err);
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
