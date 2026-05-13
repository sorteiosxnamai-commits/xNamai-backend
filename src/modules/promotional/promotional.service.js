import { getPool } from "../../db.js";
import { mpCreatePixPayment } from "../../services/mercadopago.js";
import {
  attachPromotionalPixPayment,
  createPromotionalDraw,
  createPromotionalNumbers,
  countPromotionalNumbersByContact,
  deletePromotionalDraw,
  getPromotionalDrawById,
  getPromotionalNumbers,
  getPromotionalNumbersAdmin,
  getPromotionalParticipants,
  getPromotionalReservationForPayment,
  listActivePromotionalDraws,
  listPromotionalDraws,
  listPromotionalParticipationsForUser,
  reservePromotionalNumbers,
  settlePromotionalPaymentApproved,
  updatePromotionalDraw,
  updatePromotionalDrawStatus,
  updatePromotionalNumberStatus,
} from "./promotional.repository.js";
import {
  validateCreatePromotionalDraw,
  validateNumberStatus,
  validatePromotionalStatus,
  validateReservationPayload,
  validateUpdatePromotionalDraw,
} from "./promotional.validators.js";

function notFound(message, code) {
  const err = new Error(message);
  err.status = 404;
  err.code = code;
  return err;
}

function httpError(status, code, message) {
  const err = new Error(message || code);
  err.status = status;
  err.code = code;
  return err;
}

function forbidden(message, code) {
  const err = new Error(message);
  err.status = 403;
  err.code = code;
  return err;
}

function isPubliclyAvailable(draw) {
  if (!draw || !["active", "published", "open"].includes(String(draw.status || "").toLowerCase())) {
    return false;
  }

  const now = Date.now();
  if (draw.starts_at && new Date(draw.starts_at).getTime() > now) return false;
  if (draw.ends_at && new Date(draw.ends_at).getTime() < now) return false;

  return true;
}

export async function listPublicDraws() {
  return listActivePromotionalDraws();
}

export async function getPublicDraw(id) {
  const draw = await getPromotionalDrawById(Number(id));
  if (!draw || !isPubliclyAvailable(draw)) {
    if (draw) throw httpError(400, "promotional_draw_closed", "Sorteio promocional fechado.");
    throw notFound("Sorteio promocional não encontrado.", "promotional_draw_not_found");
  }
  return draw;
}

export async function getAdminDraw(id) {
  const draw = await getPromotionalDrawById(Number(id));
  if (!draw) throw notFound("Sorteio promocional não encontrado.", "promotional_draw_not_found");
  return draw;
}

export async function getNumbers(draw_id, { requireActive = false } = {}) {
  const draw = requireActive
    ? await getPublicDraw(draw_id)
    : await getAdminDraw(draw_id);
  const numbers = requireActive
    ? await getPromotionalNumbers(draw.id)
    : await getPromotionalNumbersAdmin(draw.id);
  return { draw, numbers };
}

export async function createDraw(payload) {
  const data = validateCreatePromotionalDraw(payload);
  const pool = await getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const draw = await createPromotionalDraw(data, client);
    await createPromotionalNumbers(draw.id, data.number_start, data.number_end, client);
    await client.query("COMMIT");
    return getPromotionalDrawById(draw.id);
  } catch (err) {
    console.error("[PROMOTIONAL_ERROR]", {
      code: err?.code,
      message: err?.message,
      detail: err?.detail,
      hint: err?.hint,
      stack: err?.stack,
    });
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function updateDraw(id, payload) {
  await getAdminDraw(id);
  const data = validateUpdatePromotionalDraw(payload);
  const draw = await updatePromotionalDraw(Number(id), data);
  if (!draw) throw notFound("Sorteio promocional não encontrado.", "promotional_draw_not_found");
  return getPromotionalDrawById(draw.id);
}

export async function changeDrawStatus(id, status) {
  await getAdminDraw(id);
  const normalized = validatePromotionalStatus(status);
  const draw = await updatePromotionalDrawStatus(Number(id), normalized);
  if (!draw) throw notFound("Sorteio promocional não encontrado.", "promotional_draw_not_found");
  return getPromotionalDrawById(draw.id);
}

export async function archiveDraw(id) {
  await getAdminDraw(id);
  const draw = await deletePromotionalDraw(Number(id));
  if (!draw) throw notFound("Sorteio promocional não encontrado.", "promotional_draw_not_found");
  return draw;
}

function mapPaymentStatus(status) {
  const normalized = String(status || "pending").toLowerCase();
  if (normalized === "paid") return "PAGO";
  if (normalized === "cancelled") return "CANCELADO";
  if (normalized === "expired") return "EXPIRADO";
  return "PENDENTE";
}

function mapReservationStatus(status) {
  const normalized = String(status || "pending").toLowerCase();
  if (normalized === "paid") return "PAGO";
  if (normalized === "expired") return "EXPIRADO";
  if (normalized === "cancelled") return "CANCELADO";
  if (normalized === "sorted") return "SORTEADO";
  return "RESERVADO";
}

function formatDay(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
  }).format(new Date(value));
}

export async function reserveNumbers(draw_id, payload, user = null) {
  const userId = Number(user?.id);
  const userEmail = String(user?.email || "").trim();
  const userName = String(user?.name || user?.nome || userEmail).trim();

  if (!Number.isInteger(userId) || !userEmail) {
    throw httpError(401, "login_required", "Usuário não autenticado.");
  }

  const draw = await getPublicDraw(draw_id);
  const data = validateReservationPayload(
    {
      ...payload,
      name: userName,
      email: userEmail,
      phone: payload?.buyer_phone || null,
      buyer_name: userName,
      buyer_email: userEmail,
      buyer_phone: payload?.buyer_phone || null,
    },
    {
      id: userId,
      email: userEmail,
      name: userName,
    }
  );

  if (data.numbers.length > Number(draw.max_numbers_per_user || 1)) {
    throw httpError(400, "invalid_number", "Quantidade de números acima do limite permitido.");
  }

  const alreadyReserved = await countPromotionalNumbersByContact(
    draw.id,
    data.email,
    data.phone,
    data.user_id
  );
  if (alreadyReserved + data.numbers.length > Number(draw.max_numbers_per_user || 1)) {
    throw httpError(400, "number_unavailable", "Quantidade de números acima do limite por participante.");
  }

  const outOfRange = data.numbers.filter(
    (n) => n < Number(draw.number_start) || n > Number(draw.number_end)
  );
  if (outOfRange.length) {
    const err = httpError(400, "invalid_number", "Número fora do intervalo do sorteio promocional.");
    err.conflicts = outOfRange;
    throw err;
  }

  const priceCents = Number(draw.price_cents || 0);
  const totalCents = data.numbers.length * priceCents;

  if (!Number.isFinite(priceCents) || priceCents <= 0 || totalCents <= 0) {
    throw httpError(422, "promotional_amount_invalid", "Valor do sorteio promocional inválido.");
  }

  return reservePromotionalNumbers(draw.id, {
    ...data,
    price_cents: priceCents,
    total_cents: totalCents,
    amount_cents: totalCents,
    source: "public",
  });
}

export async function createPromotionalPix(draw_id, reservation_id, user = null, options = {}) {
  const userId = Number(user?.id);
  if (!Number.isInteger(userId)) {
    throw httpError(401, "login_required", "Usuário não autenticado.");
  }

  const reservation = await getPromotionalReservationForPayment(
    Number(draw_id),
    reservation_id,
    userId
  );

  if (!reservation) {
    throw notFound("Reserva promocional não encontrada.", "reservation_not_found");
  }

  const paymentStatus = String(reservation.payment_status || "pending").toLowerCase();
  if (paymentStatus === "paid") {
    throw httpError(400, "already_paid", "Esta reserva já está paga.");
  }

  if (paymentStatus !== "pending") {
    throw httpError(400, "promotional_payment_not_pending", "Esta reserva promocional não está pendente de pagamento.");
  }

  if (["cancelled", "expired"].includes(String(reservation.status || "").toLowerCase())) {
    throw httpError(400, "promotional_draw_closed", "Esta reserva promocional não pode ser paga.");
  }

  const numbers = Array.isArray(reservation.numbers) ? reservation.numbers.map(Number) : [];
  const priceCents = Number(reservation.price_cents || 0);
  const savedTotalCents = Number(reservation.total_cents || reservation.amount_cents || 0);
  const amountCents = savedTotalCents > 0 ? savedTotalCents : numbers.length * priceCents;
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    throw httpError(422, "promotional_amount_invalid", "Valor do sorteio promocional inválido.");
  }

  const description = `Sorteio promocional xNaMai - ${reservation.title || reservation.prize || reservation.draw_id}`;
  const notificationUrl = options.notification_url || undefined;

  const pix = await mpCreatePixPayment({
    amount_cents: amountCents,
    description,
    payer_email: reservation.buyer_email || user.email,
    payer_name: reservation.buyer_name || user.name || user.email,
    external_reference: `promotional:${reservation.reservation_id}`,
    notification_url: notificationUrl,
    metadata: {
      type: "promotional",
      draw_id: reservation.draw_id,
      reservation_id: reservation.reservation_id,
      numbers,
      user_id: userId,
    },
    idempotency_key: `promotional-${reservation.reservation_id}-${Date.now()}`,
  });

  await attachPromotionalPixPayment(
    Number(draw_id),
    reservation.reservation_id,
    pix
  );

  return {
    ok: true,
    payment: {
      id: pix.payment_id,
      status: pix.status || "pending",
      qr_code: pix.qr_code,
      qr_code_base64: pix.qr_code_base64,
      ticket_url: pix.ticket_url,
      amount_cents: amountCents,
    },
    payment_id: pix.payment_id,
    reservation_id: reservation.reservation_id,
    draw_id: Number(reservation.draw_id),
    amount: pix.amount,
    amount_cents: amountCents,
    qr_code: pix.qr_code,
    qr_code_base64: pix.qr_code_base64,
    ticket_url: pix.ticket_url,
    payment_status: "pending",
  };
}

export async function listMyParticipations(user = null) {
  const userId = Number(user?.id);
  if (!Number.isInteger(userId)) {
    throw httpError(401, "login_required", "Usuário não autenticado.");
  }

  const rows = await listPromotionalParticipationsForUser(
    userId,
    user.email || ""
  );

  return rows.map((row) => {
    const numbers = Array.isArray(row.numbers) ? row.numbers.map(Number) : [];
    const priceCents = Number(row.price_cents || 0);
    const amountCents = Number(row.amount_cents || row.total_cents || 0) || numbers.length * priceCents;
    return {
      type: "promotional",
      draw_id: Number(row.draw_id),
      draw_title: row.draw_title || "",
      prize: row.prize || "",
      numbers,
      numbers_label: numbers.map((n) => String(n).padStart(2, "0")).join(", "),
      day: formatDay(row.created_at),
      payment_status: row.payment_status || "pending",
      payment_label: mapPaymentStatus(row.payment_status),
      status: row.reservation_status || "reserved",
      status_label: mapReservationStatus(row.reservation_status),
      can_pay:
        String(row.payment_status || "pending").toLowerCase() === "pending" &&
        !["cancelled", "expired"].includes(String(row.reservation_status || "").toLowerCase()),
      reservation_id: row.reservation_id,
      payment_id: row.payment_id || null,
      price_cents: priceCents,
      amount_cents: amountCents,
      total_cents: amountCents,
      created_at: row.created_at,
    };
  });
}

export async function listMyReservations(user = null) {
  const participations = await listMyParticipations(user);
  return participations.map((item) => ({
    type: "promotional",
    reservation_id: item.reservation_id,
    draw_id: item.draw_id,
    draw_title: item.draw_title,
    numbers: item.numbers.map((n) => String(n)),
    status: item.status,
    payment_status: item.payment_status,
    total_cents: item.total_cents,
    created_at: item.created_at,
  }));
}

export async function updateNumberStatus(draw_id, number, status) {
  await getAdminDraw(draw_id);

  const n = Number(number);
  if (!Number.isInteger(n) || n < 0 || n > 1000) {
    const err = new Error("Número promocional inválido.");
    err.status = 400;
    err.code = "invalid_promotional_number";
    throw err;
  }

  const normalized = validateNumberStatus(status);
  const updated = await updatePromotionalNumberStatus(Number(draw_id), n, normalized);
  if (!updated) {
    throw notFound("Número promocional não encontrado.", "promotional_number_not_found");
  }
  return updated;
}

export async function listAdminDraws() {
  return listPromotionalDraws();
}

export async function listParticipants(draw_id) {
  await getAdminDraw(draw_id);
  return getPromotionalParticipants(Number(draw_id));
}

export function assertPromotionalAdminEmail(req) {
  const raw = process.env.PROMOTIONAL_ADMIN_EMAILS || "";
  const emails = raw
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

  if (!emails.length) return;

  const current = String(req.user?.email || "").trim().toLowerCase();
  if (!emails.includes(current)) {
    throw forbidden("E-mail sem permissão para o módulo promocional.", "promotional_email_forbidden");
  }
}

export async function settlePromotionalPaymentByPaymentId(paymentId) {
  if (!paymentId) {
    return {
      ok: false,
      reason: "missing_payment_id",
    };
  }

  return settlePromotionalPaymentApproved(String(paymentId));
}
