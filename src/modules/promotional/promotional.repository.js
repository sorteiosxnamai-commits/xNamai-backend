import { randomUUID } from "crypto";
import { getPool, query } from "../../db.js";
import { formatPromotionalNumber } from "./promotional.utils.js";

function dbQuery(client, text, params = []) {
  return client ? client.query(text, params) : query(text, params);
}

export async function ensurePromotionalSchema(client = null) {
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
      status TEXT NOT NULL DEFAULT 'pending',
      payment_status TEXT DEFAULT 'pending',
      payment_id TEXT,
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
    CREATE UNIQUE INDEX IF NOT EXISTS promotional_numbers_draw_n_uq
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

  await dbQuery(client, `ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS banner_url TEXT`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS user_id INTEGER NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending'`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS payment_id TEXT NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS payment_provider TEXT NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS user_id INTEGER NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS reservation_id UUID NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending'`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS payment_id TEXT NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS buyer_name TEXT NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS buyer_email TEXT NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS buyer_phone TEXT NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMPTZ NULL`);
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
  return {
    ...row,
    n: Number(row.n),
    label: row.label || formatPromotionalNumber(row.n),
    available: row.status === "available",
  };
}

export async function listActivePromotionalDraws() {
  await ensurePromotionalSchema();
  const { rows } = await query(`
    ${drawSelect()}
    WHERE d.status = 'active'
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
    rows.push([draw_id, n, formatPromotionalNumber(n), "available"]);
  }

  if (!rows.length) return [];

  const values = [];
  const params = [];
  rows.forEach((row, index) => {
    const offset = index * 4;
    values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`);
    params.push(...row);
  });

  const { rows: inserted } = await dbQuery(client, `
    INSERT INTO public.promotional_numbers (draw_id, n, label, status)
    VALUES ${values.join(", ")}
    ON CONFLICT (draw_id, n) DO NOTHING
    RETURNING *
  `, params);

  return inserted.map(normalizeNumberRow);
}

export async function updatePromotionalNumberStatus(draw_id, n, status) {
  await ensurePromotionalSchema();
  const { rows } = await query(`
    UPDATE public.promotional_numbers
    SET status = $3,
        reservation_id = CASE WHEN $3 = 'available' THEN NULL ELSE reservation_id END,
        payment_id = CASE WHEN $3 = 'available' THEN NULL ELSE payment_id END,
        payment_status = CASE
          WHEN $3 = 'available' THEN 'pending'
          WHEN $3 = 'sold' THEN 'paid'
          ELSE payment_status
        END,
        user_id = CASE WHEN $3 = 'available' THEN NULL ELSE user_id END,
        buyer_name = CASE WHEN $3 = 'available' THEN NULL ELSE buyer_name END,
        buyer_email = CASE WHEN $3 = 'available' THEN NULL ELSE buyer_email END,
        buyer_phone = CASE WHEN $3 = 'available' THEN NULL ELSE buyer_phone END,
        reserved_at = CASE
          WHEN $3 = 'available' THEN NULL
          WHEN $3 = 'reserved' THEN NOW()
          ELSE reserved_at
        END,
        sold_at = CASE
          WHEN $3 = 'available' THEN NULL
          WHEN $3 = 'sold' THEN NOW()
          ELSE sold_at
        END,
        updated_at = NOW()
    WHERE draw_id = $1
      AND n = $2
    RETURNING *
  `, [draw_id, n, status]);

  return rows[0] ? normalizeNumberRow(rows[0]) : null;
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
      r.numbers,
      r.status AS reservation_status,
      r.payment_status,
      r.payment_id,
      r.created_at,
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

export async function getPromotionalReservationForPayment(draw_id, reservation_id) {
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
      r.payment_id,
      r.expires_at,
      d.title,
      d.prize,
      d.price_cents
    FROM public.promotional_reservations r
    JOIN public.promotional_draws d ON d.id = r.draw_id
    WHERE r.id = $1
      AND r.draw_id = $2
    LIMIT 1
  `, [reservation_id, draw_id]);
  return rows[0] || null;
}

export async function attachPromotionalPixPayment(draw_id, reservation_id, payment_id) {
  await ensurePromotionalSchema();
  await query(`
    UPDATE public.promotional_reservations
    SET payment_id = $3,
        payment_status = 'pending',
        payment_provider = 'mercadopago',
        updated_at = NOW()
    WHERE id = $1
      AND draw_id = $2
  `, [reservation_id, draw_id, payment_id]);

  await query(`
    UPDATE public.promotional_numbers
    SET payment_id = $3,
        payment_status = 'pending',
        updated_at = NOW()
    WHERE draw_id = $1
      AND reservation_id = $2
  `, [draw_id, reservation_id, payment_id]);
}

export async function reservePromotionalNumbers(draw_id, payload) {
  const pool = await getPool();
  const client = await pool.connect();
  const reservationId = randomUUID();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  try {
    await client.query("BEGIN");
    await ensurePromotionalSchema(client);

    const locked = await client.query(`
      SELECT n, status
      FROM public.promotional_numbers
      WHERE draw_id = $1
        AND n = ANY($2::int[])
      ORDER BY n ASC
      FOR UPDATE
    `, [draw_id, payload.numbers]);

    const found = new Set(locked.rows.map((row) => Number(row.n)));
    const missing = payload.numbers.filter((n) => !found.has(n));
    if (missing.length) {
      const err = new Error("Número promocional não encontrado.");
      err.status = 404;
      err.code = "promotional_number_not_found";
      err.conflicts = missing;
      throw err;
    }

    const unavailable = locked.rows
      .filter((row) => row.status !== "available")
      .map((row) => Number(row.n));
    if (unavailable.length) {
      const err = new Error("Número promocional indisponível.");
      err.status = 409;
      err.code = "promotional_number_unavailable";
      err.conflicts = unavailable;
      throw err;
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
        status,
        payment_status,
        expires_at
      )
      VALUES ($1,$2,$3,$4::int[],$5,$6,$7,'reserved','pending',$8)
      RETURNING *
    `, [
      reservationId,
      draw_id,
      payload.user_id,
      payload.numbers,
      payload.name,
      payload.email,
      payload.phone,
      expiresAt,
    ]);

    await client.query(`
      UPDATE public.promotional_numbers
      SET status = 'reserved',
          reservation_id = $3,
          user_id = $4,
          buyer_name = $5,
          buyer_email = $6,
          buyer_phone = $7,
          payment_status = 'pending',
          reserved_at = NOW(),
          updated_at = NOW()
      WHERE draw_id = $1
        AND n = ANY($2::int[])
    `, [
      draw_id,
      payload.numbers,
      reservationId,
      payload.user_id,
      payload.name,
      payload.email,
      payload.phone,
    ]);

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
