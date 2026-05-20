import { query } from "../db.js";

function runner(client) {
  return client && typeof client.query === "function"
    ? (sql, params = []) => client.query(sql, params)
    : (sql, params = []) => query(sql, params);
}

export async function tableExists(tableName, client = null) {
  const q = runner(client);
  const result = await q(
    `
    SELECT 1
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = $1
     LIMIT 1
    `,
    [tableName]
  );

  return result.rowCount > 0;
}

export async function columnType(tableName, columnName, client = null) {
  const q = runner(client);
  const result = await q(
    `
    SELECT udt_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
       AND column_name = $2
     LIMIT 1
    `,
    [tableName, columnName]
  );

  return result.rows?.[0]?.udt_name || null;
}

export async function reservationIdIsUuid(client = null) {
  const type = await columnType("reservations", "id", client);
  return String(type).toLowerCase() === "uuid";
}

export async function ensureMainRaffleCompat(client = null) {
  const q = runner(client);

  await q(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

  const drawsExists = await tableExists("draws", client);
  if (drawsExists) {
    await q(`ALTER TABLE public.draws ADD COLUMN IF NOT EXISTS price_cents INTEGER NOT NULL DEFAULT 5500`);
    await q(`ALTER TABLE public.draws ADD COLUMN IF NOT EXISTS ticket_price_cents INTEGER`);
    await q(`ALTER TABLE public.draws ADD COLUMN IF NOT EXISTS cashback_percent INTEGER NOT NULL DEFAULT 100`);
    await q(`
      UPDATE public.draws
         SET ticket_price_cents = COALESCE(ticket_price_cents, price_cents, 5500),
             price_cents = COALESCE(price_cents, ticket_price_cents, 5500),
             cashback_percent = COALESCE(cashback_percent, 100)
    `);
  }

  const paymentsExists = await tableExists("payments", client);
  if (paymentsExists) {
    await q(`ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'mercadopago'`);
    await q(`ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS coupon_credited BOOLEAN NOT NULL DEFAULT FALSE`);
    await q(`ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS coupon_credited_at TIMESTAMPTZ NULL`);
    await q(`ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS coupon_cashback_percent INTEGER NULL`);
    await q(`ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS coupon_amount_cents INTEGER NULL`);
    await q(`ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
    await q(`ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS provider_payment_id TEXT NULL`);
    await q(`ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS external_reference TEXT NULL`);
    await q(`ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS pix_qr_code TEXT NULL`);
    await q(`ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS pix_qr_code_base64 TEXT NULL`);
    await q(`ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS pix_ticket_url TEXT NULL`);
    await q(`ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS pix_copy_paste TEXT NULL`);
    await q(`ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS raw JSONB NULL`);
  }

  if (!(await tableExists("coupon_balance_history", client))) {
    await q(`
      CREATE TABLE IF NOT EXISTS public.coupon_balance_history (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id int4 NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
        payment_id text NULL REFERENCES public.payments(id) ON DELETE SET NULL,
        delta_cents int4 NOT NULL,
        balance_before_cents int4 NOT NULL,
        balance_after_cents int4 NOT NULL,
        event_type text NOT NULL,
        channel text NULL,
        status text NULL,
        draw_id int4 NULL,
        reservation_id text NULL,
        run_trace_id text NULL,
        meta jsonb NOT NULL DEFAULT '{}'::jsonb,
        gross_amount_cents int4 NULL,
        cashback_percent int4 NULL,
        cashback_amount_cents int4 NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await q(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_coupon_hist_payment_credit_purchase
        ON public.coupon_balance_history (payment_id, event_type)
        WHERE payment_id IS NOT NULL AND event_type = 'CREDIT_PURCHASE'
    `);
  }

  const couponHistoryExists = await tableExists("coupon_balance_history", client);
  if (couponHistoryExists) {
    await q(`ALTER TABLE public.coupon_balance_history ADD COLUMN IF NOT EXISTS gross_amount_cents INTEGER NULL`);
    await q(`ALTER TABLE public.coupon_balance_history ADD COLUMN IF NOT EXISTS cashback_percent INTEGER NULL`);
    await q(`ALTER TABLE public.coupon_balance_history ADD COLUMN IF NOT EXISTS cashback_amount_cents INTEGER NULL`);
  }

  const numbersExists = await tableExists("numbers", client);
  if (numbersExists) {
    await q(`ALTER TABLE public.numbers ADD COLUMN IF NOT EXISTS n SMALLINT`);
    await q(`ALTER TABLE public.numbers ADD COLUMN IF NOT EXISTS number INTEGER`);
    await q(`ALTER TABLE public.numbers ADD COLUMN IF NOT EXISTS user_id BIGINT`);
    await q(`ALTER TABLE public.numbers ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending'`);
    await q(`ALTER TABLE public.numbers ADD COLUMN IF NOT EXISTS payment_id TEXT`);
    await q(`ALTER TABLE public.numbers ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMPTZ`);
    await q(`ALTER TABLE public.numbers ADD COLUMN IF NOT EXISTS reserved_until TIMESTAMPTZ`);
    await q(`ALTER TABLE public.numbers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);
    await q(`ALTER TABLE public.numbers ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`);
    await q(`ALTER TABLE public.numbers ADD COLUMN IF NOT EXISTS sold_at TIMESTAMPTZ NULL`);

    await q(`
      UPDATE public.numbers
         SET n = number::smallint
       WHERE n IS NULL
         AND number IS NOT NULL
    `);

    await q(`
      UPDATE public.numbers
         SET number = n::int
       WHERE number IS NULL
         AND n IS NOT NULL
    `);
  }

  const reservationsExists = await tableExists("reservations", client);
  if (reservationsExists) {
    await q(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS reservation_group_id UUID DEFAULT gen_random_uuid()`);
    await q(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS numbers INTEGER[] DEFAULT '{}'`);
    await q(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS number INTEGER`);
    await q(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS quantity INTEGER DEFAULT 1`);
    await q(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS price_cents INTEGER DEFAULT 0`);
    await q(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS total_cents INTEGER DEFAULT 0`);
    await q(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS total_amount_cents INTEGER DEFAULT 0`);
    await q(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS amount_cents INTEGER DEFAULT 0`);
    await q(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending'`);
    await q(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS payment_id TEXT`);
    await q(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS payment_provider TEXT DEFAULT 'mercadopago'`);
    await q(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS pix_qr_code TEXT`);
    await q(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS pix_qr_code_base64 TEXT`);
    await q(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS pix_copy_paste TEXT`);
    await q(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS pix_ticket_url TEXT`);
    await q(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS buyer_name TEXT`);
    await q(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS buyer_email TEXT`);
    await q(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS buyer_phone TEXT`);
    await q(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'public'`);
    await q(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`);
    await q(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);
    await q(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`);
    await q(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ NULL`);

    await q(`ALTER TABLE public.reservations ALTER COLUMN number DROP NOT NULL`);

    await q(`
      UPDATE public.reservations
         SET reservation_group_id = COALESCE(reservation_group_id, gen_random_uuid()),
             numbers = CASE
               WHEN numbers IS NULL OR cardinality(numbers) = 0 THEN ARRAY[number]::integer[]
               ELSE numbers
             END,
             quantity = COALESCE(quantity, cardinality(numbers), 1),
             total_cents = COALESCE(NULLIF(total_cents, 0), amount_cents, total_amount_cents, price_cents, 0),
             total_amount_cents = COALESCE(NULLIF(total_amount_cents, 0), total_cents, amount_cents, price_cents, 0),
             amount_cents = COALESCE(NULLIF(amount_cents, 0), total_cents, total_amount_cents, price_cents, 0),
             payment_status = COALESCE(payment_status, 'pending')
    `);
  }
}

const OPEN_DRAW_STATUSES = ["open", "active", "aberto", "ativo"];

const MAIN_DRAW_SELECT = `
  d.id,
  d.status,
  COALESCE(d.title, d.product_name, d.prize_title) AS title,
  COALESCE(d.prize_title, d.title, d.product_name) AS prize,
  COALESCE(d.promo_text, d.banner_title, '') AS promo_text,
  COALESCE(d.banner_title, d.promo_text, '') AS banner_title,
  COALESCE(d.ticket_price_cents, d.price_cents, 5500)::int AS ticket_price_cents,
  COALESCE(d.price_cents, d.ticket_price_cents, 5500)::int AS price_cents,
  COALESCE(d.max_numbers_per_user, 5)::int AS max_numbers_per_user,
  COALESCE(d.cashback_percent, 100)::int AS cashback_percent,
  COALESCE(d.opened_at, d.created_at) AS opened_at,
  d.closed_at,
  d.realized_at,
  d.winner_user_id,
  d.created_at
`;

export function normalizeMainDrawPayload(row) {
  if (!row) return null;

  const ticketCents = Number(row.ticket_price_cents ?? row.price_cents ?? 5500);

  return {
    id: Number(row.id),
    status: String(row.status || "open").toLowerCase(),
    title: row.title || row.product_name || row.prize_title || null,
    prize: row.prize || row.prize_title || row.title || null,
    promo_text: row.promo_text || row.banner_title || "",
    banner_title: row.banner_title || row.promo_text || "",
    ticket_price_cents: ticketCents,
    price_cents: Number(row.price_cents ?? ticketCents),
    max_numbers_per_user: Number(row.max_numbers_per_user || 5),
    cashback_percent: Number(row.cashback_percent ?? 100),
    opened_at: row.opened_at || null,
    closed_at: row.closed_at || null,
    realized_at: row.realized_at || null,
    winner_user_id: row.winner_user_id ?? null,
    created_at: row.created_at || null,
  };
}

export async function fetchCurrentOpenDraw(client = null) {
  await ensureMainRaffleCompat(client);

  const q = runner(client);
  const result = await q(
    `
    SELECT ${MAIN_DRAW_SELECT}
      FROM public.draws d
     WHERE LOWER(COALESCE(d.status, '')) = ANY($1::text[])
     ORDER BY d.id DESC
     LIMIT 1
    `,
    [OPEN_DRAW_STATUSES]
  );

  return normalizeMainDrawPayload(result.rows[0] || null);
}

export async function fetchDrawById(drawId, client = null) {
  await ensureMainRaffleCompat(client);

  const q = runner(client);
  const result = await q(
    `
    SELECT ${MAIN_DRAW_SELECT}
      FROM public.draws d
     WHERE d.id = $1
     LIMIT 1
    `,
    [Number(drawId)]
  );

  return normalizeMainDrawPayload(result.rows[0] || null);
}

export async function getTicketPriceCents(client = null, drawId) {
  await ensureMainRaffleCompat(client);

  const q = runner(client);

  const result = await q(
    `
    SELECT COALESCE(ticket_price_cents, price_cents, 5500)::int AS price_cents
      FROM public.draws
     WHERE id = $1
     LIMIT 1
    `,
    [drawId]
  );

  return Number(result.rows?.[0]?.price_cents || 5500);
}
