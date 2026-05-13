import { randomUUID } from "crypto";
import { getPool, query } from "../../db.js";
import { formatPromotionalNumber } from "./promotional.utils.js";

const PROMOTIONAL_RESERVATION_TTL_MINUTES = 30;

function dbQuery(client, text, params = []) {
  return client ? client.query(text, params) : query(text, params);
}

export async function ensurePromotionalSchema(client = null) {
  await dbQuery(client, `CREATE EXTENSION IF NOT EXISTS pgcrypto`);

  await dbQuery(client, `
    CREATE TABLE IF NOT EXISTS public.promotional_draws (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      prize TEXT DEFAULT '',
      price_cents INTEGER NOT NULL DEFAULT 0,
      number_start INTEGER NOT NULL,
      number_end INTEGER NOT NULL,
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

  await dbQuery(client, `
    CREATE TABLE IF NOT EXISTS public.promotional_reservations (
      id UUID PRIMARY KEY,
      draw_id BIGINT NOT NULL REFERENCES public.promotional_draws(id) ON DELETE CASCADE,
      user_id INTEGER,
      numbers INTEGER[] NOT NULL DEFAULT '{}',
      buyer_name TEXT NOT NULL DEFAULT '',
      buyer_email TEXT NOT NULL DEFAULT '',
      buyer_phone TEXT NOT NULL DEFAULT '',
      price_cents INTEGER NOT NULL DEFAULT 0,
      total_cents INTEGER NOT NULL DEFAULT 0,
      amount_cents INTEGER NOT NULL DEFAULT 0,
      source TEXT DEFAULT 'public',
      status TEXT NOT NULL DEFAULT 'pending',
      payment_status TEXT DEFAULT 'pending',
      payment_provider TEXT,
      payment_id TEXT,
      pix_qr_code TEXT,
      pix_qr_code_base64 TEXT,
      pix_copy_paste TEXT,
      pix_ticket_url TEXT,
      paid_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await dbQuery(client, `
    CREATE TABLE IF NOT EXISTS public.promotional_numbers (
      id BIGSERIAL PRIMARY KEY,
      draw_id BIGINT NOT NULL REFERENCES public.promotional_draws(id) ON DELETE CASCADE,
      n INTEGER NOT NULL,
      number_value INTEGER,
      label TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'available',
      user_id INTEGER,
      reservation_id UUID REFERENCES public.promotional_reservations(id) ON DELETE SET NULL,
      payment_id TEXT,
      payment_status TEXT DEFAULT 'pending',
      buyer_name TEXT,
      buyer_email TEXT,
      buyer_phone TEXT,
      reserved_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      sold_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await dbQuery(client, `
    CREATE INDEX IF NOT EXISTS promotional_draws_status_idx
    ON public.promotional_draws(status)
  `);
  await dbQuery(client, `
    CREATE INDEX IF NOT EXISTS promotional_numbers_draw_n_idx
    ON public.promotional_numbers(draw_id, n)
  `);
  await dbQuery(client, `
    CREATE INDEX IF NOT EXISTS promotional_numbers_draw_status_idx
    ON public.promotional_numbers(draw_id, status)
  `);
  await dbQuery(client, `
    CREATE INDEX IF NOT EXISTS promotional_reservations_draw_idx
    ON public.promotional_reservations(draw_id, created_at DESC)
  `);

  await dbQuery(client, `
    CREATE TABLE IF NOT EXISTS public.promotional_payments (
      id BIGSERIAL PRIMARY KEY,
      reservation_id UUID REFERENCES public.promotional_reservations(id) ON DELETE CASCADE,
      draw_id BIGINT REFERENCES public.promotional_draws(id) ON DELETE CASCADE,
      user_id INTEGER,
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

  await dbQuery(client, `ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS banner_url TEXT`);
  await dbQuery(client, `ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS description TEXT DEFAULT ''`);
  await dbQuery(client, `ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS prize TEXT DEFAULT ''`);
  await dbQuery(client, `ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft'`);
  await dbQuery(client, `ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS price_cents INTEGER NOT NULL DEFAULT 0`);
  await dbQuery(client, `ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS number_start INTEGER DEFAULT 0`);
  await dbQuery(client, `ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS number_end INTEGER DEFAULT 99`);
  await dbQuery(client, `ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);
  await dbQuery(client, `ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS user_id INTEGER NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending'`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS payment_id TEXT NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS payment_provider TEXT NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS price_cents INTEGER NOT NULL DEFAULT 0`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS total_cents INTEGER NOT NULL DEFAULT 0`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS amount_cents INTEGER NOT NULL DEFAULT 0`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'public'`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS pix_qr_code TEXT NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS pix_qr_code_base64 TEXT NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS pix_copy_paste TEXT NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS pix_ticket_url TEXT NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ALTER COLUMN id SET DEFAULT gen_random_uuid()`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS user_id INTEGER NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS n INTEGER NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS number_value INTEGER NULL`);
  await dbQuery(client, `UPDATE public.promotional_numbers SET n = number_value WHERE n IS NULL AND number_value IS NOT NULL`);
  await dbQuery(client, `UPDATE public.promotional_numbers SET number_value = n WHERE number_value IS NULL AND n IS NOT NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS label TEXT`);
  await dbQuery(client, `UPDATE public.promotional_numbers SET label = COALESCE(label, number_value::text, n::text) WHERE label IS NULL`);
  await dbQuery(client, `
    DO $$
    DECLARE
      reservation_type text;
    BEGIN
      SELECT udt_name
        INTO reservation_type
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'promotional_numbers'
         AND column_name = 'reservation_id';

      IF reservation_type IS NULL THEN
        ALTER TABLE public.promotional_numbers ADD COLUMN reservation_id UUID NULL;
      ELSIF reservation_type <> 'uuid' THEN
        BEGIN
          ALTER TABLE public.promotional_numbers DROP CONSTRAINT IF EXISTS promotional_numbers_reservation_id_fkey;
        EXCEPTION WHEN OTHERS THEN
          NULL;
        END;

        ALTER TABLE public.promotional_numbers
          ALTER COLUMN reservation_id TYPE UUID
          USING CASE
            WHEN reservation_id::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              THEN reservation_id::text::uuid
            ELSE NULL
          END;
      END IF;
    END $$;
  `);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending'`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS payment_id TEXT NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS buyer_name TEXT NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS buyer_email TEXT NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS buyer_phone TEXT NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMPTZ NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NULL`);

  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS payment_provider TEXT NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS payment_id TEXT NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending'`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);

  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS payment_id TEXT NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending'`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS sold_at TIMESTAMPTZ NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);

  await dbQuery(client, `
    CREATE INDEX IF NOT EXISTS promotional_reservations_payment_id_idx
    ON public.promotional_reservations(payment_id)
  `);
  await dbQuery(client, `
    CREATE INDEX IF NOT EXISTS promotional_numbers_payment_id_idx
    ON public.promotional_numbers(payment_id)
  `);
  await dbQuery(client, `
    CREATE INDEX IF NOT EXISTS promotional_numbers_draw_number_value_idx
    ON public.promotional_numbers(draw_id, number_value)
  `);
  await dbQuery(client, `
    CREATE INDEX IF NOT EXISTS promotional_payments_payment_id_idx
    ON public.promotional_payments(payment_id)
  `);
  await dbQuery(client, `
    CREATE INDEX IF NOT EXISTS promotional_payments_reservation_idx
    ON public.promotional_payments(reservation_id)
  `);
}

function drawSelect() {
  return `
    SELECT
      d.*,
      COUNT(n.n)::int AS total_numbers,
      COUNT(n.n) FILTER (WHERE n.status = 'available')::int AS available_numbers,
      COUNT(n.n) FILTER (WHERE n.status = 'reserved')::int AS reserved_numbers,
      COUNT(n.n) FILTER (WHERE n.status = 'sold')::int AS sold_numbers,
      COUNT(n.n) FILTER (WHERE n.status = 'blocked')::int AS blocked_numbers
    FROM public.promotional_draws d
    LEFT JOIN public.promotional_numbers n ON n.draw_id = d.id
  `;
}

function normalizeNumberRow(row) {
  const value = row.n ?? row.number_value;
  return {
    ...row,
    n: Number(value),
    number_value: Number(value),
    label: row.label || formatPromotionalNumber(value),
    available: row.status === "available",
  };
}

function mapAdminNumberRow(row) {
  if (!row) return null;
  const value = row.n ?? row.number_value;
  return {
    id: Number(row.id),
    draw_id: Number(row.draw_id),
    n: Number(value),
    number_value: Number(value),
    label: row.label || formatPromotionalNumber(value),
    status: row.status,
    user_id: row.user_id != null ? Number(row.user_id) : null,
    reservation_id: row.reservation_id != null ? String(row.reservation_id) : null,
    buyer_name: row.buyer_name ?? null,
    buyer_email: row.buyer_email ?? null,
    buyer_phone: row.buyer_phone ?? null,
    payment_status: row.payment_status ?? "pending",
    payment_id: row.payment_id ?? null,
    reserved_at: row.reserved_at ?? null,
    sold_at: row.sold_at ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

export async function listActivePromotionalDraws() {
  await ensurePromotionalSchema();
  const { rows } = await query(`
    ${drawSelect()}
    WHERE d.status IN ('active', 'published', 'open')
      AND (d.starts_at IS NULL OR d.starts_at <= NOW())
      AND (d.ends_at IS NULL OR d.ends_at >= NOW())
    GROUP BY d.id
    ORDER BY d.created_at DESC, d.id DESC
  `);
  return rows;
}

export async function listPromotionalDraws() {
  await ensurePromotionalSchema();
  const { rows } = await query(`
    ${drawSelect()}
    GROUP BY d.id
    ORDER BY d.created_at DESC, d.id DESC
  `);
  return rows;
}

export async function getPromotionalDrawById(id, client = null) {
  await ensurePromotionalSchema(client);
  const { rows } = await dbQuery(client, `
    ${drawSelect()}
    WHERE d.id = $1
    GROUP BY d.id
    LIMIT 1
  `, [id]);
  return rows[0] || null;
}

export async function getPromotionalNumbers(draw_id, client = null) {
  await ensurePromotionalSchema(client);
  const { rows } = await dbQuery(client, `
    SELECT *
    FROM public.promotional_numbers
    WHERE draw_id = $1
    ORDER BY n ASC
  `, [draw_id]);
  return rows.map(normalizeNumberRow);
}

export async function getPromotionalNumbersAdmin(draw_id, client = null) {
  await ensurePromotionalSchema(client);
  const { rows } = await dbQuery(client, `
    SELECT
      id,
      draw_id,
      COALESCE(n, number_value) AS n,
      COALESCE(number_value, n) AS number_value,
      label,
      status,
      user_id,
      reservation_id,
      buyer_name,
      buyer_email,
      buyer_phone,
      payment_status,
      payment_id,
      reserved_at,
      sold_at,
      created_at,
      updated_at
    FROM public.promotional_numbers
    WHERE draw_id = $1
    ORDER BY n ASC
  `, [draw_id]);
  return rows.map(mapAdminNumberRow);
}

export async function createPromotionalDraw(payload, client = null) {
  await ensurePromotionalSchema(client);
  const { rows } = await dbQuery(client, `
    INSERT INTO public.promotional_draws (
      title,
      description,
      prize,
      price_cents,
      number_start,
      number_end,
      max_numbers_per_user,
      status,
      banner_url,
      starts_at,
      ends_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    RETURNING *
  `, [
    payload.title,
    payload.description,
    payload.prize,
    payload.price_cents,
    payload.number_start,
    payload.number_end,
    payload.max_numbers_per_user,
    payload.status,
    payload.banner_url,
    payload.starts_at,
    payload.ends_at,
  ]);
  return rows[0];
}

export async function updatePromotionalDraw(id, payload) {
  await ensurePromotionalSchema();
  const fields = [];
  const values = [id];

  for (const [key, value] of Object.entries(payload)) {
    values.push(value);
    fields.push(`${key} = $${values.length}`);
  }

  const { rows } = await query(`
    UPDATE public.promotional_draws
    SET ${fields.join(", ")},
        updated_at = NOW()
    WHERE id = $1
    RETURNING *
  `, values);
  return rows[0] || null;
}

export async function updatePromotionalDrawStatus(id, status) {
  await ensurePromotionalSchema();
  const { rows } = await query(`
    UPDATE public.promotional_draws
    SET status = $2,
        updated_at = NOW()
    WHERE id = $1
    RETURNING *
  `, [id, status]);
  return rows[0] || null;
}

export async function deletePromotionalDraw(id) {
  await ensurePromotionalSchema();
  const { rows } = await query(`
    UPDATE public.promotional_draws
    SET status = 'inactive',
        updated_at = NOW()
    WHERE id = $1
    RETURNING *
  `, [id]);
  return rows[0] || null;
}

export async function createPromotionalNumbers(draw_id, number_start, number_end, client = null) {
  await ensurePromotionalSchema(client);
  const rows = [];

  for (let n = number_start; n <= number_end; n += 1) {
    rows.push([draw_id, n, n, formatPromotionalNumber(n), "available"]);
  }

  if (!rows.length) return [];

  const values = [];
  const params = [];
  rows.forEach((row, index) => {
    const offset = index * 5;
    values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`);
    params.push(...row);
  });

  const { rows: inserted } = await dbQuery(client, `
    WITH input(draw_id, n, number_value, label, status) AS (
      VALUES ${values.join(", ")}
    )
    INSERT INTO public.promotional_numbers (draw_id, n, number_value, label, status)
    SELECT i.draw_id, i.n, i.number_value, i.label, i.status
    FROM input i
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.promotional_numbers pn
      WHERE pn.draw_id = i.draw_id
        AND COALESCE(pn.n, pn.number_value) = i.n
    )
    RETURNING *
  `, params);

  return inserted.map(normalizeNumberRow);
}

export async function updatePromotionalNumberStatus(draw_id, n, status) {
  await ensurePromotionalSchema();
  const s = String(status || "").toLowerCase();

  let sql;
  const params = [draw_id, n];

  if (s === "available") {
    sql = `
      UPDATE public.promotional_numbers
      SET
        status = 'available',
        user_id = NULL,
        reservation_id = NULL,
        payment_id = NULL,
        payment_status = 'pending',
        buyer_name = NULL,
        buyer_email = NULL,
        buyer_phone = NULL,
        reserved_at = NULL,
        sold_at = NULL,
        updated_at = NOW()
      WHERE draw_id = $1 AND n = $2
      RETURNING *
    `;
  } else if (s === "sold") {
    sql = `
      UPDATE public.promotional_numbers
      SET
        status = 'sold',
        sold_at = NOW(),
        updated_at = NOW()
      WHERE draw_id = $1 AND n = $2
      RETURNING *
    `;
  } else if (s === "reserved") {
    sql = `
      UPDATE public.promotional_numbers
      SET
        status = 'reserved',
        reserved_at = COALESCE(reserved_at, NOW()),
        updated_at = NOW()
      WHERE draw_id = $1 AND n = $2
      RETURNING *
    `;
  } else if (s === "blocked") {
    sql = `
      UPDATE public.promotional_numbers
      SET
        status = 'blocked',
        updated_at = NOW()
      WHERE draw_id = $1 AND n = $2
      RETURNING *
    `;
  } else {
    return null;
  }

  const { rows } = await query(sql, params);
  return rows[0] ? mapAdminNumberRow(rows[0]) : null;
}

export async function getPromotionalParticipants(draw_id) {
  await ensurePromotionalSchema();
  const { rows } = await query(`
    SELECT
      r.id AS reservation_id,
      r.user_id,
      r.buyer_name,
      r.buyer_email,
      r.buyer_phone,
      r.numbers,
      r.status,
      r.payment_status,
      r.payment_id,
      r.created_at,
      r.expires_at
    FROM public.promotional_reservations r
    WHERE r.draw_id = $1
    ORDER BY r.created_at DESC
  `, [draw_id]);
  return rows;
}

export async function countPromotionalNumbersByContact(draw_id, email, phone, user_id = null) {
  await ensurePromotionalSchema();
  const { rows } = await query(`
    SELECT COALESCE(SUM(cardinality(numbers)), 0)::int AS total
    FROM public.promotional_reservations
    WHERE draw_id = $1
      AND status IN ('pending', 'reserved', 'paid')
      AND (
        ($4::integer IS NOT NULL AND user_id = $4::integer)
        OR lower(buyer_email) = lower($2)
        OR (
          $3 <> ''
          AND regexp_replace(buyer_phone, '\\D', '', 'g') = regexp_replace($3, '\\D', '', 'g')
        )
      )
  `, [draw_id, email, phone || "", user_id]);
  return Number(rows[0]?.total || 0);
}

export async function listPromotionalParticipationsForUser(user_id, email) {
  await ensurePromotionalSchema();
  const { rows } = await query(`
    SELECT
      r.id AS reservation_id,
      r.draw_id,
      r.user_id,
      r.numbers,
      r.status AS reservation_status,
      r.payment_status,
      r.payment_id,
      COALESCE(NULLIF(r.price_cents, 0), d.price_cents, 0)::int AS price_cents,
      COALESCE(NULLIF(r.total_cents, 0), NULLIF(r.amount_cents, 0), cardinality(r.numbers) * COALESCE(d.price_cents, 0), 0)::int AS total_cents,
      COALESCE(NULLIF(r.amount_cents, 0), NULLIF(r.total_cents, 0), cardinality(r.numbers) * COALESCE(d.price_cents, 0), 0)::int AS amount_cents,
      r.created_at,
      r.expires_at,
      r.paid_at,
      d.title AS draw_title,
      d.prize
    FROM public.promotional_reservations r
    JOIN public.promotional_draws d ON d.id = r.draw_id
    WHERE
      r.user_id = $1
      OR LOWER(r.buyer_email) = LOWER($2)
    ORDER BY r.created_at DESC
  `, [user_id, email || ""]);
  return rows;
}

export async function getPromotionalReservationForPayment(draw_id, reservation_id, user_id = null) {
  await ensurePromotionalSchema();
  const { rows } = await query(`
    SELECT
      r.id AS reservation_id,
      r.draw_id,
      r.user_id,
      r.numbers,
      r.buyer_name,
      r.buyer_email,
      r.buyer_phone,
      r.status,
      r.payment_status,
      COALESCE(NULLIF(r.price_cents, 0), d.price_cents, 0)::int AS price_cents,
      COALESCE(NULLIF(r.total_cents, 0), NULLIF(r.amount_cents, 0), cardinality(r.numbers) * COALESCE(d.price_cents, 0), 0)::int AS total_cents,
      COALESCE(NULLIF(r.amount_cents, 0), NULLIF(r.total_cents, 0), cardinality(r.numbers) * COALESCE(d.price_cents, 0), 0)::int AS amount_cents,
      r.payment_provider,
      r.payment_id,
      r.pix_qr_code,
      r.pix_qr_code_base64,
      r.pix_ticket_url,
      r.expires_at,
      d.title,
      d.prize
    FROM public.promotional_reservations r
    JOIN public.promotional_draws d ON d.id = r.draw_id
    WHERE r.id = $1
      AND r.draw_id = $2
      AND ($3::integer IS NULL OR r.user_id = $3::integer)
    LIMIT 1
  `, [reservation_id, draw_id, user_id]);
  return rows[0] || null;
}

export async function attachPromotionalPixPayment(draw_id, reservation_id, pix) {
  await ensurePromotionalSchema();
  const paymentId = typeof pix === "object" ? pix.payment_id : pix;
  const status = typeof pix === "object" ? pix.status : "pending";
  const statusDetail = typeof pix === "object" ? pix.status_detail : null;
  const amountCents = typeof pix === "object" ? pix.amount_cents : 0;
  const qrCode = typeof pix === "object" ? pix.qr_code : null;
  const qrCodeBase64 = typeof pix === "object" ? pix.qr_code_base64 : null;
  const ticketUrl = typeof pix === "object" ? pix.ticket_url : null;
  const externalReference = typeof pix === "object" ? pix.external_reference : null;
  const raw = typeof pix === "object" ? pix.raw : null;

  await query(`
    UPDATE public.promotional_reservations
    SET payment_id = $3,
        payment_status = 'pending',
        payment_provider = 'mercadopago',
        pix_qr_code = $4,
        pix_qr_code_base64 = $5,
        pix_copy_paste = $4,
        pix_ticket_url = $6,
        updated_at = NOW()
    WHERE id = $1
      AND draw_id = $2
  `, [reservation_id, draw_id, paymentId, qrCode, qrCodeBase64, ticketUrl]);

  await query(`
    UPDATE public.promotional_numbers
    SET payment_id = $3,
        payment_status = 'pending',
        updated_at = NOW()
    WHERE draw_id = $1
      AND reservation_id = $2
  `, [draw_id, reservation_id, paymentId]);

  await query(`
    INSERT INTO public.promotional_payments (
      reservation_id,
      draw_id,
      user_id,
      provider,
      payment_id,
      external_reference,
      status,
      status_detail,
      amount_cents,
      qr_code,
      qr_code_base64,
      ticket_url,
      raw
    )
    SELECT
      r.id,
      r.draw_id,
      r.user_id,
      'mercadopago',
      $3,
      $4,
      $5,
      $6,
      $7,
      $8,
      $9,
      $10,
      $11::jsonb
    FROM public.promotional_reservations r
    WHERE r.id = $1
      AND r.draw_id = $2
    ON CONFLICT (payment_id)
    DO UPDATE SET
      status = EXCLUDED.status,
      status_detail = EXCLUDED.status_detail,
      amount_cents = EXCLUDED.amount_cents,
      qr_code = EXCLUDED.qr_code,
      qr_code_base64 = EXCLUDED.qr_code_base64,
      ticket_url = EXCLUDED.ticket_url,
      raw = EXCLUDED.raw,
      updated_at = NOW()
  `, [
    reservation_id,
    draw_id,
    paymentId,
    externalReference,
    status || "pending",
    statusDetail,
    amountCents || 0,
    qrCode,
    qrCodeBase64,
    ticketUrl,
    raw ? JSON.stringify(raw) : null,
  ]);
}

export async function reservePromotionalNumbers(draw_id, payload) {
  const pool = await getPool();
  const client = await pool.connect();
  const reservationId = randomUUID();
  const expiresAt = new Date(Date.now() + PROMOTIONAL_RESERVATION_TTL_MINUTES * 60 * 1000).toISOString();

  try {
    await client.query("BEGIN");
    await ensurePromotionalSchema(client);

    if (payload.numbers.length) {
      const params = [draw_id];
      const values = payload.numbers.map((n, index) => {
        const offset = index * 2;
        params.push(n, formatPromotionalNumber(n));
        return `($1, $${offset + 2}, $${offset + 2}, $${offset + 3}, 'available')`;
      });

      await client.query(`
        WITH input(draw_id, n, number_value, label, status) AS (
          VALUES ${values.join(", ")}
        )
        INSERT INTO public.promotional_numbers (draw_id, n, number_value, label, status)
        SELECT i.draw_id, i.n, i.number_value, i.label, i.status
        FROM input i
        WHERE NOT EXISTS (
          SELECT 1
          FROM public.promotional_numbers pn
          WHERE pn.draw_id = i.draw_id
            AND COALESCE(pn.n, pn.number_value) = i.n
        )
      `, params);
    }

    const locked = await client.query(`
      SELECT id, n, status, payment_status
      FROM public.promotional_numbers
      WHERE draw_id = $1
        AND n = ANY($2::int[])
      ORDER BY n ASC
      FOR UPDATE
    `, [draw_id, payload.numbers]);

    const found = new Set(locked.rows.map((row) => Number(row.n)));
    const missing = payload.numbers.filter((n) => !found.has(n));
    if (missing.length) {
      const err = new Error("Um ou mais números já estão reservados.");
      err.status = 409;
      err.code = "PROMOTIONAL_NUMBER_ALREADY_RESERVED";
      err.conflicts = missing;
      throw err;
    }

    const unavailable = locked.rows
      .filter((row) => {
        const status = String(row.status || "").toLowerCase();
        const paymentStatus = String(row.payment_status || "").toLowerCase();
        return status !== "available" || ["paid", "approved", "pago"].includes(paymentStatus);
      })
      .map((row) => Number(row.n));
    if (unavailable.length) {
      const err = new Error("Um ou mais números já estão reservados.");
      err.status = 409;
      err.code = "PROMOTIONAL_NUMBER_ALREADY_RESERVED";
      err.conflicts = unavailable;
      throw err;
    }

    const selectedNumberIds = [];
    const selectedByNumber = new Set();
    for (const row of locked.rows) {
      const number = Number(row.n);
      if (!selectedByNumber.has(number)) {
        selectedByNumber.add(number);
        selectedNumberIds.push(Number(row.id));
      }
    }

    const reservation = await client.query(`
      INSERT INTO public.promotional_reservations (
        id,
        draw_id,
        user_id,
        numbers,
        buyer_name,
        buyer_email,
        buyer_phone,
        price_cents,
        total_cents,
        amount_cents,
        source,
        status,
        payment_status,
        expires_at,
        created_at,
        updated_at
      )
      VALUES ($1,$2,$3,$4::int[],$5,$6,$7,$8,$9,$10,$11,'reserved','pending',$12,NOW(),NOW())
      RETURNING *
    `, [
      reservationId,
      draw_id,
      payload.user_id,
      payload.numbers,
      payload.name,
      payload.email,
      payload.phone || "",
      payload.price_cents || 0,
      payload.total_cents || 0,
      payload.amount_cents || payload.total_cents || 0,
      payload.source || "public",
      expiresAt,
    ]);

    let updateResult;
    try {
      updateResult = await client.query(`
        UPDATE public.promotional_numbers
        SET
          status = 'reserved',
          number_value = COALESCE(number_value, n),
          reservation_id = $3,
          user_id = $4,
          buyer_name = $5,
          buyer_email = $6,
          buyer_phone = $7,
          payment_status = 'pending',
          reserved_at = NOW(),
          expires_at = $9,
          updated_at = NOW()
        WHERE draw_id = $1
          AND n = ANY($2::int[])
          AND status = 'available'
          AND id = ANY($8::bigint[])
      `, [
        draw_id,
        payload.numbers,
        reservationId,
        payload.user_id,
        payload.name,
        payload.email,
        payload.phone || null,
        selectedNumberIds,
        expiresAt,
      ]);
    } catch (updateErr) {
      console.error("[PROMOTIONAL_RESERVE_NUMBER_UPDATE_ERROR]", {
        code: updateErr?.code,
        message: updateErr?.message,
        detail: updateErr?.detail,
        hint: updateErr?.hint,
        stack: updateErr?.stack,
      });
      const err = new Error("Erro ao processar número promocional.");
      err.status = 500;
      err.code = "promotional_reserve_number_update_failed";
      err.cause = updateErr;
      throw err;
    }

    const expected = payload.numbers.length;
    if (Number(updateResult.rowCount) !== expected) {
      console.error("[PROMOTIONAL_RESERVE_NUMBER_UPDATE_ERROR]", {
        code: "ROWCOUNT_MISMATCH",
        message: `Esperado ${expected} linhas, atualizadas ${updateResult.rowCount}`,
        detail: { draw_id, numbers: payload.numbers },
        hint: null,
        stack: null,
      });
      const err = new Error("Um ou mais números já estão reservados.");
      err.status = 409;
      err.code = "PROMOTIONAL_NUMBER_ALREADY_RESERVED";
      throw err;
    }

    await client.query("COMMIT");
    return reservation.rows[0];
  } catch (err) {
    console.error("[PROMOTIONAL_RESERVE_ERROR]", {
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

export async function settlePromotionalPaymentApproved(payment_id) {
  await ensurePromotionalSchema();

  const pool = await getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const reservationResult = await client.query(`
      SELECT
        id,
        draw_id,
        user_id,
        numbers,
        payment_id,
        payment_status,
        status
      FROM public.promotional_reservations
      WHERE payment_id = $1
      FOR UPDATE
    `, [String(payment_id)]);

    if (!reservationResult.rows.length) {
      await client.query("COMMIT");
      return {
        ok: false,
        reason: "promotional_reservation_not_found_for_payment",
        payment_id: String(payment_id),
      };
    }

    const reservation = reservationResult.rows[0];

    await client.query(`
      UPDATE public.promotional_reservations
      SET
        status = 'paid',
        payment_status = 'paid',
        paid_at = COALESCE(paid_at, NOW()),
        updated_at = NOW()
      WHERE id = $1
    `, [reservation.id]);

    await client.query(`
      UPDATE public.promotional_numbers
      SET
        status = 'sold',
        payment_status = 'paid',
        payment_id = $3,
        sold_at = COALESCE(sold_at, NOW()),
        updated_at = NOW()
      WHERE draw_id = $1
        AND reservation_id = $2
    `, [
      reservation.draw_id,
      reservation.id,
      String(payment_id),
    ]);

    await client.query(`
      UPDATE public.promotional_payments
      SET
        status = 'approved',
        updated_at = NOW()
      WHERE payment_id = $1
    `, [String(payment_id)]);

    await client.query("COMMIT");

    return {
      ok: true,
      payment_id: String(payment_id),
      reservation_id: reservation.id,
      draw_id: reservation.draw_id,
      numbers: reservation.numbers,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[PROMOTIONAL_SETTLE_PAYMENT_ERROR]", {
      payment_id: String(payment_id),
      code: err?.code,
      message: err?.message,
      detail: err?.detail,
      stack: err?.stack,
    });
    throw err;
  } finally {
    client.release();
  }
}
