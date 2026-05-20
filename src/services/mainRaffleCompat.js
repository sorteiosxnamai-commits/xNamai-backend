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
