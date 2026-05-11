import { getPool } from "../../db.js";
import {
  createPromotionalDraw,
  createPromotionalNumbers,
  countPromotionalNumbersByContact,
  deletePromotionalDraw,
  getPromotionalDrawById,
  getPromotionalNumbers,
  getPromotionalParticipants,
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
  const numbers = await getPromotionalNumbers(draw.id);
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
  return "RESERVADO";
}

function formatDay(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
  }).format(new Date(value));
}

export async function reserveNumbers(draw_id, payload, user = null) {
  const draw = await getPublicDraw(draw_id);
  const data = validateReservationPayload(payload, user);

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
      payment: mapPaymentStatus(row.payment_status),
      status: mapReservationStatus(row.reservation_status),
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
