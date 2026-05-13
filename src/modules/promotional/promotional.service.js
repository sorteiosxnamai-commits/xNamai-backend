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

function forbidden(message, code) {
  const err = new Error(message);
  err.status = 403;
  err.code = code;
  return err;
}

function isPubliclyAvailable(draw) {
  if (!draw || draw.status !== "active") return false;

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
    const err = new Error("Usuário não autenticado.");
    err.status = 401;
    err.code = "unauthorized";
    throw err;
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
    const err = new Error("Quantidade de números acima do limite permitido.");
    err.status = 400;
    err.code = "promotional_limit_exceeded";
    throw err;
  }

  const alreadyReserved = await countPromotionalNumbersByContact(
    draw.id,
    data.email,
    data.phone,
    data.user_id
  );
  if (alreadyReserved + data.numbers.length > Number(draw.max_numbers_per_user || 1)) {
    const err = new Error("Quantidade de números acima do limite por participante.");
    err.status = 400;
    err.code = "promotional_user_limit_exceeded";
    throw err;
  }

  const outOfRange = data.numbers.filter(
    (n) => n < Number(draw.number_start) || n > Number(draw.number_end)
  );
  if (outOfRange.length) {
    const err = new Error("Número fora do intervalo do sorteio promocional.");
    err.status = 400;
    err.code = "promotional_number_out_of_range";
    err.conflicts = outOfRange;
    throw err;
  }

  return reservePromotionalNumbers(draw.id, data);
}

export async function createPromotionalPix(draw_id, reservation_id, user = null, options = {}) {
  const userId = Number(user?.id);
  if (!Number.isInteger(userId)) {
    const err = new Error("Usuário não autenticado.");
    err.status = 401;
    err.code = "unauthorized";
    throw err;
  }

  const reservation = await getPromotionalReservationForPayment(
    Number(draw_id),
    reservation_id
  );

  if (!reservation) {
    throw notFound("Reserva promocional não encontrada.", "promotional_reservation_not_found");
  }

  const userEmail = String(user?.email || "").trim().toLowerCase();
  const ownerEmail = String(reservation.buyer_email || "").trim().toLowerCase();
  const isOwner = Number(reservation.user_id) === userId || (userEmail && ownerEmail === userEmail);

  if (!isOwner) {
    const err = new Error("Você não tem permissão para pagar esta reserva.");
    err.status = 403;
    err.code = "promotional_reservation_forbidden";
    throw err;
  }

  const paymentStatus = String(reservation.payment_status || "pending").toLowerCase();
  if (paymentStatus === "paid") {
    const err = new Error("Esta reserva já está paga.");
    err.status = 400;
    err.code = "promotional_payment_already_paid";
    throw err;
  }

  if (paymentStatus !== "pending") {
    const err = new Error("Esta reserva promocional não está pendente de pagamento.");
    err.status = 400;
    err.code = "promotional_payment_not_pending";
    throw err;
  }

  if (["cancelled", "expired"].includes(String(reservation.status || "").toLowerCase())) {
    const err = new Error("Esta reserva promocional não pode ser paga.");
    err.status = 400;
    err.code = "promotional_reservation_not_payable";
    throw err;
  }

  const numbers = Array.isArray(reservation.numbers) ? reservation.numbers.map(Number) : [];
  const priceCents = Number(reservation.price_cents || 0);
  if (!Number.isFinite(priceCents) || priceCents <= 0) {
    const err = new Error("Preço do sorteio promocional inválido.");
    err.status = 400;
    err.code = "invalid_promotional_price";
    throw err;
  }

  const amountCents = numbers.length * priceCents;
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
    pix.payment_id
  );

  return {
    ok: true,
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
    const err = new Error("Usuário não autenticado.");
    err.status = 401;
    err.code = "unauthorized";
    throw err;
  }

  const rows = await listPromotionalParticipationsForUser(
    userId,
    user.email || ""
  );

  return rows.map((row) => {
    const numbers = Array.isArray(row.numbers) ? row.numbers.map(Number) : [];
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
      created_at: row.created_at,
    };
  });
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
