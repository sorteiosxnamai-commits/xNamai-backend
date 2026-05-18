import express from "express";
import crypto from "node:crypto";
import { getPool } from "../../db.js";
import { requireAuth } from "../../middleware/auth.js";
import { mpCreatePixPayment } from "../../services/mercadopago.js";

const router = express.Router();

const DEFAULT_PRICE_CENTS = Number(process.env.PRICE_CENTS || process.env.PIX_PRICE || 5500);
const RESERVATION_TTL_MINUTES = Number(process.env.PROMOTIONAL_RESERVATION_TTL_MINUTES || 30);
const SOURCE = "promotional_direct_v1";

function toInt(value, fallback = null) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function centsFromDraw(draw) {
  const fromDraw = toInt(draw?.price_cents, 0);
  return fromDraw > 0 ? fromDraw : DEFAULT_PRICE_CENTS;
}

function formatNumber(value) {
  const parsed = toInt(value, 0);
  return String(parsed).padStart(2, "0");
}

function normalizeNumbers(input) {
  const raw = Array.isArray(input)
    ? input
    : Array.isArray(input?.numbers)
      ? input.numbers
      : Array.isArray(input?.selected_numbers)
        ? input.selected_numbers
        : [];

  return [...new Set(
    raw
      .map((item) => (typeof item === "object" && item !== null ? item.number ?? item.n ?? item.value : item))
      .map((item) => Number.parseInt(item, 10))
      .filter((item) => Number.isInteger(item) && item >= 0)
  )];
}

function getBaseUrl(req) {
  return (
    process.env.PUBLIC_URL ||
    process.env.BACKEND_PUBLIC_URL ||
    `${req.protocol}://${req.get("host")}`
  ).replace(/\/+$/, "");
}

function safeUserId(user) {
  return toInt(user?.id || user?.sub, null);
}

function buyerFromRequest(req) {
  const bodyCustomer = req.body?.customer || {};

  return {
    name: bodyCustomer.name || req.body?.name || req.user?.name || req.user?.email || "Cliente xNaMai",
    email: bodyCustomer.email || req.body?.email || req.user?.email || "comprador@xnamai.com",
    phone: bodyCustomer.phone || bodyCustomer.celular || req.body?.phone || req.user?.phone || "",
  };
}

async function columnType(client, table, column) {
  const { rows } = await client.query(
    `SELECT udt_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = $2
      LIMIT 1`,
    [table, column]
  );

  return rows[0]?.udt_name || null;
}

function reservationIdAssignmentSql(type, param = "$4") {
  if (["int2", "int4", "int8", "numeric"].includes(type)) return `${param}::bigint`;
  if (type === "uuid") return `${param}::uuid`;
  return `${param}::text`;
}

async function ensurePromotionalDirectSchema(client) {
  await client.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS public.promotional_draws (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      prize TEXT DEFAULT '',
      price_cents INTEGER NOT NULL DEFAULT 0,
      number_start INTEGER NOT NULL DEFAULT 0,
      number_end INTEGER NOT NULL DEFAULT 99,
      max_numbers_per_user INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'draft',
      banner_url TEXT,
      starts_at TIMESTAMPTZ,
      ends_at TIMESTAMPTZ,
      archived_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS public.promotional_reservations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      reservation_id UUID UNIQUE DEFAULT gen_random_uuid(),
      draw_id BIGINT NOT NULL REFERENCES public.promotional_draws(id) ON DELETE CASCADE,
      user_id BIGINT,
      numbers INTEGER[] NOT NULL DEFAULT '{}',
      buyer_name TEXT DEFAULT '',
      buyer_email TEXT DEFAULT '',
      buyer_phone TEXT DEFAULT '',
      price_cents INTEGER NOT NULL DEFAULT 0,
      total_cents INTEGER NOT NULL DEFAULT 0,
      amount_cents INTEGER NOT NULL DEFAULT 0,
      source TEXT DEFAULT 'public',
      status TEXT NOT NULL DEFAULT 'reserved',
      payment_status TEXT NOT NULL DEFAULT 'pending',
      payment_provider TEXT,
      payment_id TEXT,
      preference_id TEXT,
      pix_qr_code TEXT,
      pix_qr_code_base64 TEXT,
      pix_copy_paste TEXT,
      pix_ticket_url TEXT,
      expires_at TIMESTAMPTZ,
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS public.promotional_numbers (
      id BIGSERIAL PRIMARY KEY,
      draw_id BIGINT NOT NULL REFERENCES public.promotional_draws(id) ON DELETE CASCADE,
      n INTEGER,
      number_value INTEGER,
      number TEXT,
      label TEXT,
      status TEXT NOT NULL DEFAULT 'available',
      user_id BIGINT,
      reservation_id UUID,
      reserved_by TEXT,
      payment_id TEXT,
      payment_status TEXT DEFAULT 'pending',
      buyer_name TEXT,
      buyer_email TEXT,
      buyer_phone TEXT,
      reserved_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      reserved_until TIMESTAMPTZ,
      sold_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS public.promotional_payments (
      id BIGSERIAL PRIMARY KEY,
      reservation_id UUID,
      draw_id BIGINT,
      user_id BIGINT,
      provider TEXT NOT NULL DEFAULT 'mercadopago',
      payment_id TEXT UNIQUE,
      external_reference TEXT,
      status TEXT DEFAULT 'pending',
      status_detail TEXT,
      amount_cents INTEGER NOT NULL DEFAULT 0,
      qr_code TEXT,
      qr_code_base64 TEXT,
      ticket_url TEXT,
      raw JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await client.query(`ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS price_cents INTEGER NOT NULL DEFAULT 0`);
  await client.query(`ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS number_start INTEGER NOT NULL DEFAULT 0`);
  await client.query(`ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS number_end INTEGER NOT NULL DEFAULT 99`);
  await client.query(`ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS max_numbers_per_user INTEGER NOT NULL DEFAULT 1`);
  await client.query(`ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft'`);
  await client.query(`ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`);

  await client.query(`ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS reservation_id UUID DEFAULT gen_random_uuid()`);
  await client.query(`ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS user_id BIGINT`);
  await client.query(`ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS numbers INTEGER[] NOT NULL DEFAULT '{}'`);
  await client.query(`ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS buyer_name TEXT DEFAULT ''`);
  await client.query(`ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS buyer_email TEXT DEFAULT ''`);
  await client.query(`ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS buyer_phone TEXT DEFAULT ''`);
  await client.query(`ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS price_cents INTEGER NOT NULL DEFAULT 0`);
  await client.query(`ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS total_cents INTEGER NOT NULL DEFAULT 0`);
  await client.query(`ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS amount_cents INTEGER NOT NULL DEFAULT 0`);
  await client.query(`ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'public'`);
  await client.query(`ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'reserved'`);
  await client.query(`ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'pending'`);
  await client.query(`ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS payment_provider TEXT`);
  await client.query(`ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS payment_id TEXT`);
  await client.query(`ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS pix_qr_code TEXT`);
  await client.query(`ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS pix_qr_code_base64 TEXT`);
  await client.query(`ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS pix_copy_paste TEXT`);
  await client.query(`ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS pix_ticket_url TEXT`);
  await client.query(`ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`);
  await client.query(`ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);
  await client.query(`UPDATE public.promotional_reservations SET reservation_id = gen_random_uuid() WHERE reservation_id IS NULL`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS promotional_reservations_reservation_id_unique ON public.promotional_reservations(reservation_id) WHERE reservation_id IS NOT NULL`);

  await client.query(`ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS n INTEGER`);
  await client.query(`ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS number_value INTEGER`);
  await client.query(`ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS number TEXT`);
  await client.query(`ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS label TEXT`);
  await client.query(`ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'available'`);
  await client.query(`ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS user_id BIGINT`);
  await client.query(`ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS payment_id TEXT`);
  await client.query(`ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending'`);
  await client.query(`ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS buyer_name TEXT`);
  await client.query(`ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS buyer_email TEXT`);
  await client.query(`ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS buyer_phone TEXT`);
  await client.query(`ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMPTZ`);
  await client.query(`ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`);
  await client.query(`ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS reserved_until TIMESTAMPTZ`);
  await client.query(`ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS sold_at TIMESTAMPTZ`);
  await client.query(`ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);

  await client.query(`UPDATE public.promotional_numbers SET n = COALESCE(n, number_value, NULLIF(regexp_replace(number::text, '\\D', '', 'g'), '')::int) WHERE n IS NULL`);
  await client.query(`UPDATE public.promotional_numbers SET number_value = COALESCE(number_value, n, NULLIF(regexp_replace(number::text, '\\D', '', 'g'), '')::int) WHERE number_value IS NULL`);
  await client.query(`UPDATE public.promotional_numbers SET number = LPAD(COALESCE(n, number_value, 0)::text, 2, '0') WHERE number IS NULL OR number = ''`);
  await client.query(`UPDATE public.promotional_numbers SET label = LPAD(COALESCE(n, number_value, 0)::text, 2, '0') WHERE label IS NULL OR label = ''`);

  await client.query(`UPDATE public.promotional_reservations SET status = 'reserved' WHERE status IS NULL OR status IN ('reservado', 'reserve')`);
  await client.query(`UPDATE public.promotional_reservations SET status = 'paid' WHERE status IN ('approved', 'pago', 'vendido', 'sold')`);
  await client.query(`UPDATE public.promotional_reservations SET payment_status = 'pending' WHERE payment_status IS NULL OR payment_status IN ('created', 'waiting', 'pendente')`);
  await client.query(`UPDATE public.promotional_reservations SET payment_status = 'paid' WHERE payment_status IN ('approved', 'pago')`);

  await client.query(`ALTER TABLE public.promotional_reservations DROP CONSTRAINT IF EXISTS promotional_reservations_status_check`);
  await client.query(`
    ALTER TABLE public.promotional_reservations
    ADD CONSTRAINT promotional_reservations_status_check
    CHECK (LOWER(TRIM(status)) IN ('reserved','pending','paid','approved','expired','cancelled','canceled','blocked','unavailable','sold'))
  `);

  await client.query(`ALTER TABLE public.promotional_reservations DROP CONSTRAINT IF EXISTS promotional_reservations_payment_status_check`);
  await client.query(`
    ALTER TABLE public.promotional_reservations
    ADD CONSTRAINT promotional_reservations_payment_status_check
    CHECK (LOWER(TRIM(payment_status)) IN ('pending','paid','approved','expired','cancelled','canceled','failed','refunded'))
  `);

  await client.query(`ALTER TABLE public.promotional_numbers DROP CONSTRAINT IF EXISTS promotional_numbers_status_check`);
  await client.query(`
    ALTER TABLE public.promotional_numbers
    ADD CONSTRAINT promotional_numbers_status_check
    CHECK (LOWER(TRIM(status)) IN ('available','reserved','sold','paid','approved','blocked','unavailable'))
  `);

  await client.query(`CREATE INDEX IF NOT EXISTS promotional_numbers_draw_idx ON public.promotional_numbers(draw_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS promotional_numbers_draw_status_idx ON public.promotional_numbers(draw_id, status)`);
  await client.query(`CREATE INDEX IF NOT EXISTS promotional_reservations_draw_idx ON public.promotional_reservations(draw_id)`);
}

async function getDraw(client, drawId) {
  const { rows } = await client.query(
    `SELECT d.*,
            COALESCE(NULLIF(d.price_cents, 0), $2)::int AS resolved_price_cents,
            COUNT(pn.id)::int AS total_numbers,
            COUNT(pn.id) FILTER (WHERE pn.status = 'available')::int AS available_numbers,
            COUNT(pn.id) FILTER (WHERE pn.status = 'reserved')::int AS reserved_numbers,
            COUNT(pn.id) FILTER (WHERE pn.status IN ('sold','paid','approved'))::int AS sold_numbers,
            COUNT(pn.id) FILTER (WHERE pn.status IN ('blocked','unavailable'))::int AS blocked_numbers
       FROM public.promotional_draws d
       LEFT JOIN public.promotional_numbers pn ON pn.draw_id = d.id
      WHERE d.id = $1
        AND COALESCE(d.archived_at, NULL) IS NULL
      GROUP BY d.id
      LIMIT 1`,
    [drawId, DEFAULT_PRICE_CENTS]
  );

  return rows[0] || null;
}

async function releaseExpired(client, drawId) {
  await client.query(
    `UPDATE public.promotional_numbers
        SET status = 'available',
            user_id = NULL,
            reservation_id = NULL,
            reserved_by = NULL,
            payment_id = NULL,
            payment_status = 'pending',
            buyer_name = NULL,
            buyer_email = NULL,
            buyer_phone = NULL,
            reserved_at = NULL,
            expires_at = NULL,
            reserved_until = NULL,
            updated_at = NOW()
      WHERE draw_id = $1
        AND status = 'reserved'
        AND COALESCE(payment_status, 'pending') NOT IN ('paid','approved')
        AND COALESCE(expires_at, reserved_until) IS NOT NULL
        AND COALESCE(expires_at, reserved_until) <= NOW()`,
    [drawId]
  );

  await client.query(
    `UPDATE public.promotional_reservations
        SET status = 'expired',
            payment_status = 'expired',
            updated_at = NOW()
      WHERE draw_id = $1
        AND status IN ('reserved','pending')
        AND COALESCE(payment_status, 'pending') IN ('pending','waiting')
        AND expires_at IS NOT NULL
        AND expires_at <= NOW()`,
    [drawId]
  );
}

async function seedNumbers(client, draw) {
  const drawId = toInt(draw.id);
  const start = toInt(draw.number_start, 0);
  const end = toInt(draw.number_end, 99);

  for (let n = start; n <= end; n += 1) {
    await client.query(
      `INSERT INTO public.promotional_numbers (draw_id, n, number_value, number, label, status, created_at, updated_at)
       SELECT $1, $2, $2, $3, $3, 'available', NOW(), NOW()
       WHERE NOT EXISTS (
         SELECT 1
           FROM public.promotional_numbers
          WHERE draw_id = $1
            AND COALESCE(n, number_value, NULLIF(regexp_replace(number::text, '\\D', '', 'g'), '')::int) = $2
       )`,
      [drawId, n, formatNumber(n)]
    );
  }
}

function mapDraw(row) {
  if (!row) return null;

  return {
    ...row,
    id: Number(row.id),
    price_cents: Number(row.resolved_price_cents || row.price_cents || DEFAULT_PRICE_CENTS),
    number_start: toInt(row.number_start, 0),
    number_end: toInt(row.number_end, 99),
    max_numbers_per_user: toInt(row.max_numbers_per_user, 1),
  };
}

function mapNumber(row) {
  const value = toInt(row.n ?? row.number_value ?? row.number, 0);
  const status = String(row.status || "available").toLowerCase();

  return {
    id: row.id != null ? Number(row.id) : null,
    draw_id: Number(row.draw_id),
    n: value,
    number: value,
    number_value: value,
    label: row.label || formatNumber(value),
    status,
    available: status === "available",
    reserved: status === "reserved",
    sold: ["sold", "paid", "approved"].includes(status),
    blocked: ["blocked", "unavailable"].includes(status),
    reservation_id: row.reservation_id ? String(row.reservation_id) : null,
    payment_status: row.payment_status || "pending",
    expires_at: row.expires_at || row.reserved_until || null,
    reserved_until: row.reserved_until || row.expires_at || null,
  };
}

async function listNumbers(client, draw) {
  await seedNumbers(client, draw);
  await releaseExpired(client, draw.id);

  const { rows } = await client.query(
    `SELECT *
       FROM public.promotional_numbers
      WHERE draw_id = $1
      ORDER BY COALESCE(n, number_value, NULLIF(regexp_replace(number::text, '\\D', '', 'g'), '')::int) ASC`,
    [draw.id]
  );

  return rows.map(mapNumber);
}

async function createReservation(client, req, draw, numbers) {
  const start = toInt(draw.number_start, 0);
  const end = toInt(draw.number_end, 99);
  const max = toInt(draw.max_numbers_per_user, 1);

  const invalid = numbers.filter((n) => n < start || n > end);

  if (invalid.length) {
    const err = new Error(`Número promocional fora do intervalo: ${invalid.join(", ")}`);
    err.status = 400;
    throw err;
  }

  if (max > 0 && numbers.length > max) {
    const err = new Error(`Este sorteio permite no máximo ${max} número(s) por reserva.`);
    err.status = 400;
    throw err;
  }

  await seedNumbers(client, draw);
  await releaseExpired(client, draw.id);

  const locked = await client.query(
    `SELECT *
       FROM public.promotional_numbers
      WHERE draw_id = $1
        AND COALESCE(n, number_value, NULLIF(regexp_replace(number::text, '\\D', '', 'g'), '')::int) = ANY($2::int[])
      FOR UPDATE`,
    [draw.id, numbers]
  );

  if (locked.rows.length !== numbers.length) {
    const err = new Error("Um ou mais números promocionais não existem na grade do sorteio.");
    err.status = 409;
    throw err;
  }

  const unavailable = locked.rows
    .filter((row) => String(row.status || "available").toLowerCase() !== "available")
    .map((row) => row.label || row.n || row.number);

  if (unavailable.length) {
    const err = new Error(`Número(s) promocional(is) indisponível(is): ${unavailable.join(", ")}`);
    err.status = 409;
    err.code = "promotional_numbers_unavailable";
    throw err;
  }

  const buyer = buyerFromRequest(req);
  const userId = safeUserId(req.user);
  const priceCents = centsFromDraw(draw);
  const amountCents = priceCents * numbers.length;
  const expiresAt = new Date(Date.now() + RESERVATION_TTL_MINUTES * 60 * 1000);
  const reservationUuid = crypto.randomUUID();
  const idType = await columnType(client, "promotional_reservations", "id");

  let reservation;

  if (idType === "uuid") {
    const result = await client.query(
      `INSERT INTO public.promotional_reservations (
         id, reservation_id, draw_id, user_id, numbers, buyer_name, buyer_email, buyer_phone,
         price_cents, total_cents, amount_cents, source, status, payment_status, expires_at, created_at, updated_at
       ) VALUES (
         $1::uuid, $1::uuid, $2, $3, $4::int[], $5, $6, $7,
         $8, $9, $9, $10, 'reserved', 'pending', $11, NOW(), NOW()
       )
       RETURNING *`,
      [reservationUuid, draw.id, userId, numbers, buyer.name, buyer.email, buyer.phone, priceCents, amountCents, SOURCE, expiresAt]
    );

    reservation = result.rows[0];
  } else {
    const result = await client.query(
      `INSERT INTO public.promotional_reservations (
         reservation_id, draw_id, user_id, numbers, buyer_name, buyer_email, buyer_phone,
         price_cents, total_cents, amount_cents, source, status, payment_status, expires_at, created_at, updated_at
       ) VALUES (
         $1::uuid, $2, $3, $4::int[], $5, $6, $7,
         $8, $9, $9, $10, 'reserved', 'pending', $11, NOW(), NOW()
       )
       RETURNING *`,
      [reservationUuid, draw.id, userId, numbers, buyer.name, buyer.email, buyer.phone, priceCents, amountCents, SOURCE, expiresAt]
    );

    reservation = result.rows[0];
  }

  const numberReservationType = await columnType(client, "promotional_numbers", "reservation_id");
  const numberReservationValue = ["int2", "int4", "int8", "numeric"].includes(numberReservationType)
    ? reservation.id
    : reservation.reservation_id || reservationUuid;

  const updateResult = await client.query(
    `UPDATE public.promotional_numbers
        SET status = 'reserved',
            user_id = $3,
            reservation_id = ${reservationIdAssignmentSql(numberReservationType, "$4")},
            payment_status = 'pending',
            buyer_name = $5,
            buyer_email = $6,
            buyer_phone = $7,
            reserved_by = $6,
            reserved_at = NOW(),
            expires_at = $8,
            reserved_until = $8,
            updated_at = NOW()
      WHERE draw_id = $1
        AND COALESCE(n, number_value, NULLIF(regexp_replace(number::text, '\\D', '', 'g'), '')::int) = ANY($2::int[])
        AND status = 'available'`,
    [draw.id, numbers, userId, numberReservationValue, buyer.name, buyer.email, buyer.phone, expiresAt]
  );

  if (updateResult.rowCount !== numbers.length) {
    const err = new Error("Falha ao reservar todos os números promocionais. Tente novamente.");
    err.status = 409;
    throw err;
  }

  return {
    ...reservation,
    reservation_id: reservation.reservation_id || reservation.id,
    numbers,
    price_cents: priceCents,
    total_cents: amountCents,
    amount_cents: amountCents,
    expires_at: expiresAt.toISOString(),
  };
}

async function attachPix(req, reservationId, drawId = null) {
  const pool = await getPool();
  const client = await pool.connect();

  try {
    await ensurePromotionalDirectSchema(client);

    const { rows } = await client.query(
      `SELECT r.*, d.title AS draw_title, d.price_cents AS draw_price_cents
         FROM public.promotional_reservations r
         JOIN public.promotional_draws d ON d.id = r.draw_id
        WHERE (r.reservation_id::text = $1 OR r.id::text = $1)
          AND ($2::bigint IS NULL OR r.draw_id = $2::bigint)
        LIMIT 1`,
      [String(reservationId), drawId ? Number(drawId) : null]
    );

    const reservation = rows[0];

    if (!reservation) {
      const err = new Error("Reserva promocional não encontrada.");
      err.status = 404;
      throw err;
    }

    const currentUserId = safeUserId(req.user);

    if (
      currentUserId &&
      reservation.user_id &&
      Number(reservation.user_id) !== currentUserId &&
      req.user?.role !== "admin"
    ) {
      const err = new Error("Esta reserva promocional pertence a outro usuário.");
      err.status = 403;
      throw err;
    }

    const amountCents =
      toInt(reservation.amount_cents || reservation.total_cents, 0) ||
      (Array.isArray(reservation.numbers) ? reservation.numbers.length : 1) *
        (toInt(reservation.draw_price_cents, 0) || DEFAULT_PRICE_CENTS);

    const expiresAt = reservation.expires_at
      ? new Date(reservation.expires_at).toISOString()
      : new Date(Date.now() + RESERVATION_TTL_MINUTES * 60 * 1000).toISOString();

    const payment = await mpCreatePixPayment({
      amount_cents: amountCents,
      description: `xNaMai Promocional - ${reservation.draw_title || `Sorteio ${reservation.draw_id}`}`,
      payer_email: reservation.buyer_email || req.user?.email || "comprador@xnamai.com",
      payer_name: reservation.buyer_name || req.user?.name || "Cliente xNaMai",
      external_reference: `promotional:${reservation.reservation_id || reservation.id}`,
      notification_url: `${getBaseUrl(req)}/api/payments/webhook/mercadopago`,
      expires_at: expiresAt,
      idempotency_key: `promotional-${reservation.reservation_id || reservation.id}`,
      metadata: {
        source: "promotional",
        reservation_id: String(reservation.reservation_id || reservation.id),
        draw_id: String(reservation.draw_id),
      },
    });

    await client.query(
      `UPDATE public.promotional_reservations
          SET payment_provider = 'mercadopago',
              payment_id = $2,
              payment_status = COALESCE($3, 'pending'),
              pix_qr_code = $4,
              pix_qr_code_base64 = $5,
              pix_copy_paste = $4,
              pix_ticket_url = $6,
              updated_at = NOW()
        WHERE reservation_id::text = $1 OR id::text = $1`,
      [
        String(reservation.reservation_id || reservation.id),
        payment.payment_id,
        payment.status || "pending",
        payment.qr_code || "",
        payment.qr_code_base64 || "",
        payment.ticket_url || "",
      ]
    );

    await client.query(
      `UPDATE public.promotional_numbers
          SET payment_id = $2,
              payment_status = COALESCE($3, 'pending'),
              updated_at = NOW()
        WHERE draw_id = $4
          AND reservation_id::text IN ($1, $5)`,
      [
        String(reservation.reservation_id || reservation.id),
        payment.payment_id,
        payment.status || "pending",
        reservation.draw_id,
        String(reservation.id),
      ]
    ).catch((err) => {
      console.warn("[PROMOTIONAL_DIRECT_PIX_NUMBERS_WARN]", err?.message || err);
    });

    try {
      await client.query(
        `INSERT INTO public.promotional_payments (
           reservation_id, draw_id, user_id, provider, payment_id, external_reference,
           status, status_detail, amount_cents, qr_code, qr_code_base64, ticket_url, raw, created_at, updated_at
         ) VALUES (
           $1::uuid, $2, $3, 'mercadopago', $4, $5,
           $6, $7, $8, $9, $10, $11, $12::jsonb, NOW(), NOW()
         )
         ON CONFLICT (payment_id) DO UPDATE SET
           status = EXCLUDED.status,
           status_detail = EXCLUDED.status_detail,
           qr_code = EXCLUDED.qr_code,
           qr_code_base64 = EXCLUDED.qr_code_base64,
           ticket_url = EXCLUDED.ticket_url,
           raw = EXCLUDED.raw,
           updated_at = NOW()`,
        [
          reservation.reservation_id,
          reservation.draw_id,
          reservation.user_id,
          payment.payment_id,
          payment.external_reference,
          payment.status || "pending",
          payment.status_detail || null,
          payment.amount_cents || amountCents,
          payment.qr_code || "",
          payment.qr_code_base64 || "",
          payment.ticket_url || "",
          JSON.stringify(payment.raw || payment),
        ]
      );
    } catch (err) {
      console.warn("[PROMOTIONAL_DIRECT_PAYMENT_LOG_WARN]", err?.message || err);
    }

    return {
      ...payment,
      paymentId: payment.payment_id,
      copy_paste_code: payment.qr_code,
      copy_paste: payment.qr_code,
      pix_qr_code: payment.qr_code,
      pix_qr_code_base64: payment.qr_code_base64,
      pix_ticket_url: payment.ticket_url,
      amount_cents: payment.amount_cents || amountCents,
      source: "promotional",
      type: "promotional",
    };
  } finally {
    client.release();
  }
}

function sendError(res, err, fallback = "Erro inesperado no sorteio promocional.") {
  const status = Number(err?.status || err?.statusCode || 500);

  console.error("[PROMOTIONAL_DIRECT_ERROR]", {
    status,
    message: err?.message,
    code: err?.code,
    detail: err?.detail,
    constraint: err?.constraint,
    stack: err?.stack,
  });

  return res.status(status).json({
    ok: false,
    error: err?.code || err?.message || fallback,
    message: err?.message || fallback,
    detail: err?.detail || null,
    constraint: err?.constraint || null,
    source: SOURCE,
  });
}

router.get("/:drawId", async (req, res) => {
  const drawId = toInt(req.params.drawId);

  if (!drawId) {
    return res.status(400).json({
      ok: false,
      message: "ID do sorteio promocional inválido.",
    });
  }

  const pool = await getPool();
  const client = await pool.connect();

  try {
    res.set("X-XNAMAI-PROMOTIONAL-DIRECT", SOURCE);

    await ensurePromotionalDirectSchema(client);
    await releaseExpired(client, drawId);

    const draw = mapDraw(await getDraw(client, drawId));

    if (!draw) {
      return res.status(404).json({
        ok: false,
        message: "Sorteio promocional não encontrado.",
      });
    }

    await seedNumbers(client, draw);

    return res.json({
      ok: true,
      draw,
      data: draw,
      source: SOURCE,
    });
  } catch (err) {
    return sendError(res, err);
  } finally {
    client.release();
  }
});

router.get("/:drawId/numbers", async (req, res) => {
  const drawId = toInt(req.params.drawId);

  if (!drawId) {
    return res.status(400).json({
      ok: false,
      message: "ID do sorteio promocional inválido.",
    });
  }

  const pool = await getPool();
  const client = await pool.connect();

  try {
    res.set("X-XNAMAI-PROMOTIONAL-DIRECT", SOURCE);

    await ensurePromotionalDirectSchema(client);

    const draw = mapDraw(await getDraw(client, drawId));

    if (!draw) {
      return res.status(404).json({
        ok: false,
        message: "Sorteio promocional não encontrado.",
      });
    }

    const numbers = await listNumbers(client, draw);

    return res.json({
      ok: true,
      numbers,
      items: numbers,
      data: numbers,
      source: SOURCE,
    });
  } catch (err) {
    return sendError(res, err);
  } finally {
    client.release();
  }
});

async function checkoutHandler(req, res) {
  const drawId = toInt(req.params.drawId);
  const numbers = normalizeNumbers(req.body);

  if (!drawId) {
    return res.status(400).json({
      ok: false,
      message: "ID do sorteio promocional inválido.",
    });
  }

  if (!numbers.length) {
    return res.status(400).json({
      ok: false,
      message: "Selecione pelo menos um número promocional.",
    });
  }

  const pool = await getPool();
  const client = await pool.connect();

  let reservation;

  try {
    res.set("X-XNAMAI-PROMOTIONAL-DIRECT", SOURCE);

    await client.query("BEGIN");
    await ensurePromotionalDirectSchema(client);

    const draw = mapDraw(await getDraw(client, drawId));

    if (!draw) {
      const err = new Error("Sorteio promocional não encontrado.");
      err.status = 404;
      throw err;
    }

    reservation = await createReservation(client, req, draw, numbers);

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    return sendError(res, err);
  }

  client.release();

  try {
    const pix = await attachPix(req, reservation.reservation_id || reservation.id, drawId);

    return res.status(201).json({
      ok: true,
      reservation,
      pix,
      payment: pix,
      data: {
        reservation,
        pix,
        payment: pix,
      },
      source: SOURCE,
    });
  } catch (pixErr) {
    return res.status(201).json({
      ok: true,
      reservation,
      pix: null,
      payment: null,
      pix_error: {
        message: pixErr?.message || "Reserva criada, mas não foi possível gerar o PIX agora.",
        code: pixErr?.code || null,
        detail: pixErr?.detail || null,
      },
      source: SOURCE,
    });
  }
}

router.post("/:drawId/checkout", requireAuth, checkoutHandler);
router.post("/:drawId/reservations", requireAuth, checkoutHandler);
router.post("/:drawId/reserve", requireAuth, checkoutHandler);

router.post("/:drawId/reservations/:reservationId/pix", requireAuth, async (req, res) => {
  try {
    res.set("X-XNAMAI-PROMOTIONAL-DIRECT", SOURCE);

    const pix = await attachPix(req, req.params.reservationId, req.params.drawId);

    return res.json({
      ok: true,
      pix,
      payment: pix,
      data: {
        pix,
        payment: pix,
      },
      source: SOURCE,
    });
  } catch (err) {
    return sendError(res, err, "Não foi possível gerar PIX promocional.");
  }
});

router.post("/reservations/:reservationId/pix", requireAuth, async (req, res) => {
  try {
    res.set("X-XNAMAI-PROMOTIONAL-DIRECT", SOURCE);

    const pix = await attachPix(req, req.params.reservationId, null);

    return res.json({
      ok: true,
      pix,
      payment: pix,
      data: {
        pix,
        payment: pix,
      },
      source: SOURCE,
    });
  } catch (err) {
    return sendError(res, err, "Não foi possível gerar PIX promocional.");
  }
});

export default router;
