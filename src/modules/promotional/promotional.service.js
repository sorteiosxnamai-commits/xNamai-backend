import { getPool } from "../../db.js";
import { mpCreatePixPayment } from "../../services/mercadopago.js";
import {
  attachPromotionalPixPayment,
  attachPaymentToPromotionalReservation,
  assignPromotionalNumbersToUser,
  deletePromotionalDraw,
  getPromotionalDrawById,
  getPromotionalNumbers,
  getPromotionalNumbersAdmin,
  getPromotionalParticipants,
  getPromotionalReservationForPayment,
  listActivePromotionalDraws,
  claimPromotionalNumbersForUser,
  createPromotionalNumbers,
  getPromotionalAssignmentForUser as getPromotionalAssignmentForUserRepo,
  getPromotionalUserAllowanceForUser,
  listPromotionalParticipationsForUser,
  listPromotionalUserAllowances,
  upsertPromotionalUserAllowance,
  settlePromotionalPaymentApproved,
  updatePromotionalDraw,
  updatePromotionalDrawStatus,
  updatePromotionalNumberStatus,
} from "./promotional.repository.js";
import {
  validateCreatePromotionalDraw,
  validateNumberStatus,
  validatePromotionalStatus,
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

export async function getPublicNumbersGrid(draw_id, user = null) {
  const draw = await getPublicDraw(draw_id);
  const start = Number(draw.number_start ?? 0);
  const end = Number(draw.number_end ?? 99);

  await createPromotionalNumbers(draw.id, start, end);

  const rows = await getPromotionalNumbers(draw.id);
  const userId = user?.id != null ? Number.parseInt(user.id, 10) : null;
  const byNumber = new Map();

  for (const row of rows) {
    const n = Number(row.n ?? row.number_value ?? row.number);
    if (Number.isInteger(n)) {
      byNumber.set(n, row);
    }
  }

  const numbers = [];
  let occupied = 0;

  for (let n = start; n <= end; n += 1) {
    const row = byNumber.get(n);
    const status = String(row?.status || "available").toLowerCase();
    const isAvailable = status === "available";
    const isOccupied = !isAvailable;
    const isMine = Boolean(
      userId != null &&
      isOccupied &&
      Number(row?.user_id) === userId
    );

    if (isOccupied) occupied += 1;

    numbers.push({
      n,
      label: String(n).padStart(2, "0"),
      status: row?.status || "available",
      is_available: isAvailable,
      is_occupied: isOccupied,
      is_mine: isMine,
    });
  }

  const total = end - start + 1;

  return {
    draw_id: Number(draw.id),
    numbers,
    summary: {
      total,
      occupied,
      available: Math.max(0, total - occupied),
    },
  };
}

export async function upsertUserAllowance(draw_id, payload = {}) {
  await getAdminDraw(draw_id);
  return upsertPromotionalUserAllowance({
    drawId: draw_id,
    userId: payload.user_id || payload.userId,
    allowedQuantity: payload.allowed_quantity ?? payload.allowedQuantity,
    buyer: {
      buyer_name: payload.buyer_name || payload.name,
      buyer_email: payload.buyer_email || payload.email,
      buyer_phone: payload.buyer_phone || payload.phone,
    },
    notes: payload.notes || null,
  });
}

export async function listDrawAllowances(draw_id) {
  await getAdminDraw(draw_id);
  return listPromotionalUserAllowances(draw_id);
}

export async function getMyAllowance(drawId, user = null) {
  await getPublicDraw(drawId);
  return getPromotionalUserAllowanceForUser(drawId, user);
}

export async function claimNumbers(drawId, numbers = [], user = null) {
  await getPublicDraw(drawId);
  return claimPromotionalNumbersForUser(drawId, user, numbers);
}

async function getTableColumns(client, tableName) {
  const { rows } = await client.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
    `,
    [tableName]
  );

  return new Set(rows.map((row) => row.column_name));
}

function addInsertValue(columnsSet, insertColumns, insertValues, placeholders, columnName, value) {
  if (!columnsSet.has(columnName)) return;

  insertColumns.push(columnName);
  insertValues.push(value);
  placeholders.push(`$${insertValues.length}`);
}

function addInsertSql(columnsSet, insertColumns, placeholders, columnName, sqlExpression) {
  if (!columnsSet.has(columnName)) return;

  insertColumns.push(columnName);
  placeholders.push(sqlExpression);
}

function normalizePromotionalDrawRow(row, fallback = {}) {
  if (!row) return null;

  const price =
    row.price_cents ??
    row.ticket_price_cents ??
    row.promotional_price_cents ??
    fallback.price_cents ??
    5500;

  return {
    ...row,
    id: Number(row.id),
    price_cents: Number(price),
    ticket_price_cents: Number(row.ticket_price_cents ?? price),
    promotional_price_cents: Number(row.promotional_price_cents ?? price),
    number_start: Number(row.number_start ?? fallback.number_start ?? 0),
    number_end: Number(row.number_end ?? fallback.number_end ?? 99),
    max_numbers_per_user: Number(row.max_numbers_per_user ?? fallback.max_numbers_per_user ?? 1),
    total_numbers: Number(row.total_numbers ?? 0),
    available_numbers: Number(row.available_numbers ?? 0),
    reserved_numbers: Number(row.reserved_numbers ?? 0),
    sold_numbers: Number(row.sold_numbers ?? 0),
    blocked_numbers: Number(row.blocked_numbers ?? 0),
  };
}

export async function createDraw(payload) {
  const data = validateCreatePromotionalDraw(payload);

  const pool = await getPool();
  const client = await pool.connect();

  try {
    console.log("[PROMOTIONAL_ADMIN_CREATE_DRAW_START]", {
      title: data.title,
      price_cents: data.price_cents,
      number_start: data.number_start,
      number_end: data.number_end,
      max_numbers_per_user: data.max_numbers_per_user,
      status: data.status,
    });

    await client.query("BEGIN");

    const drawColumns = await getTableColumns(client, "promotional_draws");
    const numberColumns = await getTableColumns(client, "promotional_numbers");

    if (!drawColumns.has("id")) {
      throw new Error("Tabela public.promotional_draws inválida: coluna id não encontrada.");
    }

    if (!numberColumns.has("draw_id")) {
      throw new Error("Tabela public.promotional_numbers inválida: coluna draw_id não encontrada.");
    }

    const insertColumns = [];
    const insertValues = [];
    const placeholders = [];

    addInsertValue(drawColumns, insertColumns, insertValues, placeholders, "title", data.title);
    addInsertValue(drawColumns, insertColumns, insertValues, placeholders, "description", data.description || "");
    addInsertValue(drawColumns, insertColumns, insertValues, placeholders, "prize", data.prize || "");

    addInsertValue(drawColumns, insertColumns, insertValues, placeholders, "price_cents", data.price_cents);
    addInsertValue(drawColumns, insertColumns, insertValues, placeholders, "ticket_price_cents", data.price_cents);
    addInsertValue(drawColumns, insertColumns, insertValues, placeholders, "promotional_price_cents", data.price_cents);

    addInsertValue(drawColumns, insertColumns, insertValues, placeholders, "number_start", data.number_start);
    addInsertValue(drawColumns, insertColumns, insertValues, placeholders, "number_end", data.number_end);
    addInsertValue(
      drawColumns,
      insertColumns,
      insertValues,
      placeholders,
      "max_numbers_per_user",
      data.max_numbers_per_user
    );

    addInsertValue(drawColumns, insertColumns, insertValues, placeholders, "status", data.status || "draft");
    addInsertValue(drawColumns, insertColumns, insertValues, placeholders, "banner_url", data.banner_url || null);
    addInsertValue(drawColumns, insertColumns, insertValues, placeholders, "starts_at", data.starts_at || null);
    addInsertValue(drawColumns, insertColumns, insertValues, placeholders, "ends_at", data.ends_at || null);

    addInsertSql(drawColumns, insertColumns, placeholders, "created_at", "now()");
    addInsertSql(drawColumns, insertColumns, placeholders, "updated_at", "now()");

    if (!insertColumns.includes("title")) {
      throw new Error("Tabela public.promotional_draws inválida: coluna title não encontrada.");
    }

    const createDrawSql = `
      INSERT INTO public.promotional_draws (${insertColumns.join(", ")})
      VALUES (${placeholders.join(", ")})
      RETURNING *
    `;

    const drawResult = await client.query(createDrawSql, insertValues);
    const draw = drawResult.rows[0];

    if (!draw?.id) {
      throw new Error("Falha ao criar sorteio promocional: INSERT não retornou id.");
    }

    const numberInsertColumns = [];
    const numberSelectExpressions = [];

    if (numberColumns.has("draw_id")) {
      numberInsertColumns.push("draw_id");
      numberSelectExpressions.push("$3::int");
    }

    if (numberColumns.has("n")) {
      numberInsertColumns.push("n");
      numberSelectExpressions.push("gs.n");
    }

    if (numberColumns.has("number_value")) {
      numberInsertColumns.push("number_value");
      numberSelectExpressions.push("gs.n");
    }

    if (numberColumns.has("number")) {
      numberInsertColumns.push("number");
      numberSelectExpressions.push("LPAD(gs.n::text, 2, '0')");
    }

    if (numberColumns.has("label")) {
      numberInsertColumns.push("label");
      numberSelectExpressions.push("LPAD(gs.n::text, 2, '0')");
    }

    if (numberColumns.has("status")) {
      numberInsertColumns.push("status");
      numberSelectExpressions.push("'available'");
    }

    if (numberColumns.has("created_at")) {
      numberInsertColumns.push("created_at");
      numberSelectExpressions.push("now()");
    }

    if (numberColumns.has("updated_at")) {
      numberInsertColumns.push("updated_at");
      numberSelectExpressions.push("now()");
    }

    const duplicateConditions = [];

    if (numberColumns.has("n")) {
      duplicateConditions.push("pn.n = gs.n");
    }

    if (numberColumns.has("number_value")) {
      duplicateConditions.push("pn.number_value = gs.n");
    }

    if (numberColumns.has("number")) {
      duplicateConditions.push("(pn.number::text = gs.n::text OR pn.number::text = LPAD(gs.n::text, 2, '0'))");
    }

    if (!duplicateConditions.length) {
      throw new Error(
        "Tabela public.promotional_numbers inválida: precisa de uma coluna n, number_value ou number."
      );
    }

    const createNumbersSql = `
      INSERT INTO public.promotional_numbers (${numberInsertColumns.join(", ")})
      SELECT ${numberSelectExpressions.join(", ")}
      FROM generate_series($1::int, $2::int) AS gs(n)
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.promotional_numbers pn
        WHERE pn.draw_id = $3::int
          AND (${duplicateConditions.join(" OR ")})
      )
    `;

    await client.query(createNumbersSql, [data.number_start, data.number_end, draw.id]);

    const countResult = await client.query(
      `
        SELECT
          COUNT(*)::int AS total_numbers,
          COUNT(*) FILTER (WHERE status = 'available')::int AS available_numbers,
          COUNT(*) FILTER (WHERE status = 'reserved')::int AS reserved_numbers,
          COUNT(*) FILTER (WHERE status = 'sold')::int AS sold_numbers,
          COUNT(*) FILTER (WHERE status = 'blocked')::int AS blocked_numbers
        FROM public.promotional_numbers
        WHERE draw_id = $1
      `,
      [draw.id]
    );

    await client.query("COMMIT");

    const counts = countResult.rows[0] || {};

    const createdDraw = normalizePromotionalDrawRow(
      {
        ...draw,
        ...counts,
      },
      data
    );

    console.log("[PROMOTIONAL_ADMIN_CREATE_DRAW_SUCCESS]", {
      draw_id: createdDraw.id,
      total_numbers: createdDraw.total_numbers,
      available_numbers: createdDraw.available_numbers,
    });

    return createdDraw;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});

    console.error("[PROMOTIONAL_ADMIN_CREATE_DRAW_ERROR]", {
      code: err?.code,
      message: err?.message,
      detail: err?.detail,
      hint: err?.hint,
      table: err?.table,
      column: err?.column,
      constraint: err?.constraint,
      stack: err?.stack,
    });

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

export async function reserveNumbers(_input = {}, _user = null) {
  throw httpError(
    403,
    "promotional_public_purchase_disabled",
    "Este sorteio promocional não permite compra pelo site. Os números precisam ser liberados pelo administrador."
  );
}

export async function getPromotionalAssignmentForUser(drawId, user = null) {
  return getPromotionalAssignmentForUserRepo(drawId, user);
}

export async function assignNumbersToUser(draw_id, payload = {}) {
  return assignPromotionalNumbersToUser({
    drawId: draw_id,
    userId: payload.user_id || payload.userId || payload.client_id || payload.clientId,
    numbers: payload.numbers || payload.selectedNumbers || [],
    buyer: {
      buyer_name: payload.buyer_name || payload.name,
      buyer_email: payload.buyer_email || payload.email,
      buyer_phone: payload.buyer_phone || payload.phone,
    },
    status: payload.status || "reserved",
  });
}

export async function createPromotionalPix(draw_id, reservation_id, user = null, options = {}) {
  const userObject = typeof user === "number" || typeof user === "string" ? { id: user } : (user || {});
  const userId = Number(userObject?.id);
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
  const reservationStatus = String(reservation.status || "").toLowerCase();
  if (
    reservationStatus === "expired" ||
    paymentStatus === "expired" ||
    (reservation.expires_at && new Date(reservation.expires_at).getTime() <= Date.now())
  ) {
    throw httpError(410, "promotional_reservation_expired", "Reserva promocional expirada.");
  }

  if (!["reserved", "pending", "active"].includes(reservationStatus)) {
    throw httpError(400, "promotional_reservation_not_payable", "Reserva promocional inválida para pagamento.");
  }

  if (paymentStatus === "paid") {
    throw httpError(400, "already_paid", "Esta reserva já está paga.");
  }

  if (paymentStatus !== "pending") {
    throw httpError(400, "promotional_payment_not_pending", "Esta reserva promocional não está pendente de pagamento.");
  }

  const numbers = Array.isArray(reservation.numbers) ? reservation.numbers.map(Number) : [];
  const priceCents = Number(reservation.price_cents || 0);
  const savedTotalCents = Number(reservation.total_cents || reservation.amount_cents || 0);
  const amountCents = savedTotalCents > 0 ? savedTotalCents : numbers.length * priceCents;
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    throw httpError(
      400,
      "promotional_amount_invalid",
      "Sorteio promocional sem valor configurado. Defina o valor no admin."
    );
  }

  const description = `Sorteio promocional xNaMai - ${reservation.title || reservation.prize || reservation.draw_id}`;
  const notificationUrl = options.notification_url || undefined;

  const pix = await mpCreatePixPayment({
    amount_cents: amountCents,
    description,
    payer_email: reservation.buyer_email || userObject.email,
    payer_name: reservation.buyer_name || userObject.name || userObject.email,
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
    success: true,
    pix: {
      payment_id: pix.payment_id,
      qr_code: pix.qr_code,
      qr_code_base64: pix.qr_code_base64,
      copy_paste: pix.qr_code,
    },
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
    const source = String(row.source || "").toLowerCase();
    const isAdminAssignment =
      ["admin", "allowance_claim", "user_claim"].includes(source) ||
      String(row.payment_status || "").toLowerCase() === "approved";
    const amountCents = isAdminAssignment
      ? 0
      : Number(row.amount_cents || row.total_cents || 0) || numbers.length * priceCents;

    return {
      type: "promotional",
      draw_id: Number(row.draw_id),
      draw_title: row.draw_title || "",
      prize: row.prize || "",
      numbers,
      numbers_label: numbers.map((n) => String(n).padStart(2, "0")).join(", "),
      day: formatDay(row.created_at),
      source: row.source || null,
      payment_status: row.payment_status || "pending",
      payment_label: isAdminAssignment
        ? "Sem pagamento necessário"
        : mapPaymentStatus(row.payment_status),
      status: row.reservation_status || "reserved",
      status_label: isAdminAssignment
        ? (source === "admin" ? "Atribuído pelo admin" : "Números escolhidos")
        : mapReservationStatus(row.reservation_status),
      can_pay: isAdminAssignment
        ? false
        : String(row.payment_status || "pending").toLowerCase() === "pending" &&
          ["reserved", "pending", "active"].includes(String(row.reservation_status || "reserved").toLowerCase()),
      reservation_id: row.reservation_id,
      payment_id: row.payment_id || null,
      price_cents: isAdminAssignment ? 0 : priceCents,
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
    source: "promotional",
    reservation_id: item.reservation_id,
    draw_id: item.draw_id,
    title: item.draw_title,
    draw_title: item.draw_title,
    numbers: item.numbers.map((n) => String(n)),
    status: item.status,
    payment_status: item.payment_status,
    amount_cents: item.amount_cents,
    total_cents: item.total_cents,
    can_pay: item.can_pay,
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
  const pool = await getPool();
  const client = await pool.connect();

  try {
    const drawColumns = await getTableColumns(client, "promotional_draws");

    const orderBy = drawColumns.has("created_at")
      ? "d.created_at DESC, d.id DESC"
      : "d.id DESC";

    const { rows } = await client.query(`
      SELECT
        d.*,
        COALESCE(c.total_numbers, 0)::int AS total_numbers,
        COALESCE(c.available_numbers, 0)::int AS available_numbers,
        COALESCE(c.reserved_numbers, 0)::int AS reserved_numbers,
        COALESCE(c.sold_numbers, 0)::int AS sold_numbers,
        COALESCE(c.blocked_numbers, 0)::int AS blocked_numbers
      FROM public.promotional_draws d
      LEFT JOIN (
        SELECT
          draw_id,
          COUNT(*)::int AS total_numbers,
          COUNT(*) FILTER (WHERE status = 'available')::int AS available_numbers,
          COUNT(*) FILTER (WHERE status = 'reserved')::int AS reserved_numbers,
          COUNT(*) FILTER (WHERE status = 'sold')::int AS sold_numbers,
          COUNT(*) FILTER (WHERE status = 'blocked')::int AS blocked_numbers
        FROM public.promotional_numbers
        GROUP BY draw_id
      ) c ON c.draw_id = d.id
      ORDER BY ${orderBy}
    `);

    return rows.map((row) => normalizePromotionalDrawRow(row));
  } catch (err) {
    console.error("[PROMOTIONAL_ADMIN_LIST_DRAWS_ERROR]", {
      code: err?.code,
      message: err?.message,
      detail: err?.detail,
      hint: err?.hint,
      table: err?.table,
      column: err?.column,
      constraint: err?.constraint,
      stack: err?.stack,
    });

    throw err;
  } finally {
    client.release();
  }
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

export { attachPaymentToPromotionalReservation };
