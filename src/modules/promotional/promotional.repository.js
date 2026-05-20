import { randomUUID } from "crypto";
import { getPool, query } from "../../db.js";
import { formatPromotionalNumber } from "./promotional.utils.js";

const PROMOTIONAL_RESERVATION_TTL_MINUTES = 30;

function dbQuery(client, text, params = []) {
  return client ? client.query(text, params) : query(text, params);
}

function getDbRunner(client) {
  return client && typeof client.query === "function" ? client : { query };
}

function normalizePromotionalAdminStatus(value) {
  const raw = String(value || "").trim().toLowerCase();

  if (["ativo", "active", "publicado", "published", "open", "aberto"].includes(raw)) {
    return "active";
  }

  if (["inativo", "inactive", "draft", "rascunho"].includes(raw)) {
    return "inactive";
  }

  if (["closed", "fechado", "encerrado"].includes(raw)) {
    return "closed";
  }

  return "inactive";
}

function parsePromotionalInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

async function ensurePromotionalAdminSchema(client = null) {
  await dbQuery(client, `CREATE EXTENSION IF NOT EXISTS pgcrypto`);

  await dbQuery(client, `
    CREATE TABLE IF NOT EXISTS public.promotional_draws (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      description TEXT DEFAULT '',
      prize TEXT DEFAULT '',
      price_cents INTEGER NOT NULL DEFAULT 5500,
      ticket_price_cents INTEGER NOT NULL DEFAULT 5500,
      promotional_price_cents INTEGER NOT NULL DEFAULT 5500,
      number_start INTEGER NOT NULL DEFAULT 0,
      number_end INTEGER NOT NULL DEFAULT 99,
      max_numbers_per_user INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'inactive',
      banner_url TEXT,
      starts_at TIMESTAMPTZ,
      ends_at TIMESTAMPTZ,
      archived_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await dbQuery(client, `ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT ''`);
  await dbQuery(client, `ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS description TEXT DEFAULT ''`);
  await dbQuery(client, `ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS prize TEXT DEFAULT ''`);
  await dbQuery(client, `ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS price_cents INTEGER DEFAULT 5500`);
  await dbQuery(client, `ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS ticket_price_cents INTEGER DEFAULT 5500`);
  await dbQuery(client, `ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS promotional_price_cents INTEGER DEFAULT 5500`);
  await dbQuery(client, `ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS number_start INTEGER DEFAULT 0`);
  await dbQuery(client, `ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS number_end INTEGER DEFAULT 99`);
  await dbQuery(client, `ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS max_numbers_per_user INTEGER DEFAULT 1`);
  await dbQuery(client, `ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'inactive'`);
  await dbQuery(client, `ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS banner_url TEXT`);
  await dbQuery(client, `ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ`);
  await dbQuery(client, `ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ`);
  await dbQuery(client, `ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`);
  await dbQuery(client, `ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`);
  await dbQuery(client, `ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);

  await dbQuery(client, `
    UPDATE public.promotional_draws
       SET status = CASE
         WHEN status IS NULL OR TRIM(status::text) = '' THEN 'inactive'
         WHEN LOWER(TRIM(status::text)) IN ('ativo', 'active', 'published', 'publicado', 'open', 'aberto') THEN 'active'
         WHEN LOWER(TRIM(status::text)) IN ('inativo', 'inactive', 'draft', 'rascunho') THEN 'inactive'
         WHEN LOWER(TRIM(status::text)) IN ('closed', 'fechado', 'encerrado') THEN 'closed'
         ELSE 'inactive'
       END,
       price_cents = COALESCE(price_cents, ticket_price_cents, promotional_price_cents, 5500),
       ticket_price_cents = COALESCE(ticket_price_cents, price_cents, promotional_price_cents, 5500),
       promotional_price_cents = COALESCE(promotional_price_cents, price_cents, ticket_price_cents, 5500),
       number_start = COALESCE(number_start, 0),
       number_end = COALESCE(number_end, 99),
       max_numbers_per_user = COALESCE(max_numbers_per_user, 1),
       created_at = COALESCE(created_at, NOW()),
       updated_at = COALESCE(updated_at, NOW())
  `);

  await dbQuery(client, `ALTER TABLE public.promotional_draws ALTER COLUMN price_cents SET DEFAULT 5500`);
  await dbQuery(client, `ALTER TABLE public.promotional_draws ALTER COLUMN ticket_price_cents SET DEFAULT 5500`);
  await dbQuery(client, `ALTER TABLE public.promotional_draws ALTER COLUMN promotional_price_cents SET DEFAULT 5500`);
  await dbQuery(client, `ALTER TABLE public.promotional_draws ALTER COLUMN status SET DEFAULT 'inactive'`);

  await dbQuery(client, `ALTER TABLE public.promotional_draws DROP CONSTRAINT IF EXISTS promotional_draws_status_check`);
  await dbQuery(client, `
    ALTER TABLE public.promotional_draws
    ADD CONSTRAINT promotional_draws_status_check
    CHECK (LOWER(TRIM(status::text)) IN ('draft', 'active', 'inactive', 'closed', 'published', 'open'))
  `);

  await dbQuery(client, `
    CREATE TABLE IF NOT EXISTS public.promotional_numbers (
      id BIGSERIAL PRIMARY KEY,
      draw_id BIGINT NOT NULL REFERENCES public.promotional_draws(id) ON DELETE CASCADE,
      n INTEGER,
      number_value INTEGER,
      number TEXT,
      label TEXT,
      status TEXT DEFAULT 'available',
      payment_status TEXT DEFAULT 'pending',
      user_id BIGINT,
      reservation_id UUID,
      payment_id TEXT,
      buyer_name TEXT,
      buyer_email TEXT,
      buyer_phone TEXT,
      reserved_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      reserved_until TIMESTAMPTZ,
      sold_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS n INTEGER`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS number_value INTEGER`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS number TEXT`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS label TEXT`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'available'`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending'`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS user_id BIGINT`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS reservation_id UUID`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS payment_id TEXT`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS buyer_name TEXT`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS buyer_email TEXT`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS buyer_phone TEXT`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMPTZ`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS reserved_until TIMESTAMPTZ`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS sold_at TIMESTAMPTZ`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);

  await dbQuery(client, `
    UPDATE public.promotional_numbers
       SET status = CASE
         WHEN status IS NULL OR TRIM(status::text) = '' THEN 'available'
         WHEN LOWER(TRIM(status::text)) IN ('available', 'disponivel', 'disponível') THEN 'available'
         WHEN LOWER(TRIM(status::text)) IN ('reserved', 'reservado', 'pending', 'pendente') THEN 'reserved'
         WHEN LOWER(TRIM(status::text)) IN ('sold', 'paid', 'approved', 'vendido', 'pago') THEN 'sold'
         WHEN LOWER(TRIM(status::text)) IN ('blocked', 'unavailable', 'bloqueado', 'indisponivel', 'indisponível') THEN 'blocked'
         ELSE 'available'
       END,
       payment_status = COALESCE(payment_status, 'pending'),
       n = COALESCE(n, number_value, NULLIF(regexp_replace(number::text, '\\D', '', 'g'), '')::int),
       number_value = COALESCE(number_value, n, NULLIF(regexp_replace(number::text, '\\D', '', 'g'), '')::int),
       updated_at = COALESCE(updated_at, NOW())
  `);

  await dbQuery(client, `
    UPDATE public.promotional_numbers
       SET number = LPAD(COALESCE(n, number_value, 0)::text, 2, '0')
     WHERE number IS NULL OR TRIM(number::text) = ''
  `);

  await dbQuery(client, `
    UPDATE public.promotional_numbers
       SET label = LPAD(COALESCE(n, number_value, 0)::text, 2, '0')
     WHERE label IS NULL OR TRIM(label::text) = ''
  `);

  await dbQuery(client, `ALTER TABLE public.promotional_numbers ALTER COLUMN status SET DEFAULT 'available'`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ALTER COLUMN payment_status SET DEFAULT 'pending'`);

  await dbQuery(client, `ALTER TABLE public.promotional_numbers DROP CONSTRAINT IF EXISTS promotional_numbers_status_check`);
  await dbQuery(client, `
    ALTER TABLE public.promotional_numbers
    ADD CONSTRAINT promotional_numbers_status_check
    CHECK (LOWER(TRIM(status::text)) IN ('available', 'reserved', 'pending', 'sold', 'paid', 'approved', 'blocked', 'unavailable'))
  `);

  await dbQuery(client, `ALTER TABLE public.promotional_numbers DROP CONSTRAINT IF EXISTS promotional_numbers_payment_status_check`);
  await dbQuery(client, `
    ALTER TABLE public.promotional_numbers
    ADD CONSTRAINT promotional_numbers_payment_status_check
    CHECK (payment_status IS NULL OR LOWER(TRIM(payment_status::text)) IN ('pending', 'paid', 'approved', 'cancelled', 'canceled', 'expired'))
  `);

  await dbQuery(client, `
    CREATE INDEX IF NOT EXISTS idx_promotional_numbers_draw_id
    ON public.promotional_numbers(draw_id)
  `);

  await dbQuery(client, `
    CREATE INDEX IF NOT EXISTS idx_promotional_numbers_draw_status
    ON public.promotional_numbers(draw_id, status)
  `);
}

async function promotionalReservationIdUsesUuid(client = null) {
  const db = getDbRunner(client);
  const result = await db.query(`
    SELECT udt_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'promotional_reservations'
       AND column_name = 'id'
     LIMIT 1
  `);

  return String(result.rows?.[0]?.udt_name || "").toLowerCase() === "uuid";
}

async function ensurePromotionalRuntimeConstraints(client = null) {
  await dbQuery(client, `
    ALTER TABLE public.promotional_reservations
    ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'reserved'
  `);

  await dbQuery(client, `
    ALTER TABLE public.promotional_reservations
    ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending'
  `);

  await dbQuery(client, `
    UPDATE public.promotional_reservations
       SET status = CASE
         WHEN status IS NULL OR TRIM(status::text) = '' THEN 'reserved'

         WHEN LOWER(TRIM(status::text)) IN ('reserved', 'reservado', 'reserve') THEN 'reserved'
         WHEN LOWER(TRIM(status::text)) IN ('pending', 'pendente', 'created', 'waiting', 'waiting_payment') THEN 'pending'
         WHEN LOWER(TRIM(status::text)) IN ('paid', 'approved', 'pago', 'vendido', 'sold') THEN 'paid'
         WHEN LOWER(TRIM(status::text)) IN ('expired', 'expirado') THEN 'expired'
         WHEN LOWER(TRIM(status::text)) IN ('cancelled', 'canceled', 'cancelado', 'cancelada') THEN 'cancelled'
         WHEN LOWER(TRIM(status::text)) IN ('blocked', 'bloqueado', 'unavailable', 'indisponivel', 'indisponível') THEN 'blocked'

         ELSE 'pending'
       END
  `);

  await dbQuery(client, `
    UPDATE public.promotional_reservations
       SET payment_status = CASE
         WHEN payment_status IS NULL OR TRIM(payment_status::text) = '' THEN 'pending'

         WHEN LOWER(TRIM(payment_status::text)) IN ('pending', 'pendente', 'waiting', 'waiting_payment') THEN 'pending'
         WHEN LOWER(TRIM(payment_status::text)) IN ('paid', 'approved', 'pago') THEN 'paid'
         WHEN LOWER(TRIM(payment_status::text)) IN ('expired', 'expirado') THEN 'expired'
         WHEN LOWER(TRIM(payment_status::text)) IN ('cancelled', 'canceled', 'cancelado', 'cancelada') THEN 'cancelled'
         WHEN LOWER(TRIM(payment_status::text)) IN ('failed', 'rejected', 'recusado') THEN 'failed'
         WHEN LOWER(TRIM(payment_status::text)) IN ('refunded', 'estornado') THEN 'refunded'

         ELSE 'pending'
       END
  `);

  await dbQuery(client, `
    ALTER TABLE public.promotional_reservations
    DROP CONSTRAINT IF EXISTS promotional_reservations_status_check
  `);

  await dbQuery(client, `
    ALTER TABLE public.promotional_reservations
    ADD CONSTRAINT promotional_reservations_status_check
    CHECK (
      LOWER(TRIM(status)) IN (
        'reserved',
        'pending',
        'paid',
        'approved',
        'expired',
        'cancelled',
        'canceled',
        'blocked',
        'unavailable',
        'sold'
      )
    )
  `);

  await dbQuery(client, `
    ALTER TABLE public.promotional_reservations
    DROP CONSTRAINT IF EXISTS promotional_reservations_payment_status_check
  `);

  await dbQuery(client, `
    ALTER TABLE public.promotional_reservations
    ADD CONSTRAINT promotional_reservations_payment_status_check
    CHECK (
      LOWER(TRIM(payment_status)) IN (
        'pending',
        'paid',
        'approved',
        'expired',
        'cancelled',
        'canceled',
        'failed',
        'refunded'
      )
    )
  `);

  await dbQuery(client, `
    ALTER TABLE public.promotional_reservations
    ALTER COLUMN status SET DEFAULT 'reserved'
  `);

  await dbQuery(client, `
    ALTER TABLE public.promotional_reservations
    ALTER COLUMN payment_status SET DEFAULT 'pending'
  `);

  await dbQuery(client, `
    ALTER TABLE public.promotional_reservations
    ALTER COLUMN status SET NOT NULL
  `);

  await dbQuery(client, `
    ALTER TABLE public.promotional_reservations
    ALTER COLUMN payment_status SET NOT NULL
  `);

  await dbQuery(client, `
    ALTER TABLE public.promotional_numbers
    ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'available'
  `);

  await dbQuery(client, `
    UPDATE public.promotional_numbers
       SET status = CASE
         WHEN status IS NULL OR TRIM(status::text) = '' THEN 'available'

         WHEN LOWER(TRIM(status::text)) IN ('available', 'disponivel', 'disponível') THEN 'available'
         WHEN LOWER(TRIM(status::text)) IN ('reserved', 'reservado', 'pending', 'pendente') THEN 'reserved'
         WHEN LOWER(TRIM(status::text)) IN ('sold', 'paid', 'approved', 'vendido', 'pago') THEN 'sold'
         WHEN LOWER(TRIM(status::text)) IN ('blocked', 'bloqueado', 'unavailable', 'indisponivel', 'indisponível') THEN 'blocked'

         ELSE 'available'
       END
  `);

  await dbQuery(client, `
    ALTER TABLE public.promotional_numbers
    DROP CONSTRAINT IF EXISTS promotional_numbers_status_check
  `);

  await dbQuery(client, `
    ALTER TABLE public.promotional_numbers
    ADD CONSTRAINT promotional_numbers_status_check
    CHECK (
      LOWER(TRIM(status)) IN (
        'available',
        'reserved',
        'sold',
        'paid',
        'approved',
        'blocked',
        'unavailable'
      )
    )
  `);

  console.log("[PROMOTIONAL_SCHEMA_FIX] runtime constraints ensured", {
    promotional_reservations_status: true,
    promotional_reservations_payment_status: true,
    promotional_numbers_status: true,
  });
}

async function ensurePromotionalDrawCompatibility(client = null) {
  await dbQuery(client, `
    ALTER TABLE public.promotional_draws
    ADD COLUMN IF NOT EXISTS description TEXT DEFAULT ''
  `);

  await dbQuery(client, `
    ALTER TABLE public.promotional_draws
    ADD COLUMN IF NOT EXISTS prize TEXT DEFAULT ''
  `);

  await dbQuery(client, `
    ALTER TABLE public.promotional_draws
    ADD COLUMN IF NOT EXISTS price_cents INTEGER DEFAULT 5500
  `);

  await dbQuery(client, `
    ALTER TABLE public.promotional_draws
    ADD COLUMN IF NOT EXISTS ticket_price_cents INTEGER DEFAULT 5500
  `);

  await dbQuery(client, `
    ALTER TABLE public.promotional_draws
    ADD COLUMN IF NOT EXISTS promotional_price_cents INTEGER DEFAULT 5500
  `);

  await dbQuery(client, `
    ALTER TABLE public.promotional_draws
    ADD COLUMN IF NOT EXISTS number_start INTEGER DEFAULT 0
  `);

  await dbQuery(client, `
    ALTER TABLE public.promotional_draws
    ADD COLUMN IF NOT EXISTS number_end INTEGER DEFAULT 99
  `);

  await dbQuery(client, `
    ALTER TABLE public.promotional_draws
    ADD COLUMN IF NOT EXISTS max_numbers_per_user INTEGER DEFAULT 1
  `);

  await dbQuery(client, `
    ALTER TABLE public.promotional_draws
    ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'draft'
  `);

  await dbQuery(client, `
    ALTER TABLE public.promotional_draws
    ADD COLUMN IF NOT EXISTS banner_url TEXT
  `);

  await dbQuery(client, `
    ALTER TABLE public.promotional_draws
    ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ
  `);

  await dbQuery(client, `
    ALTER TABLE public.promotional_draws
    ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ
  `);

  await dbQuery(client, `
    ALTER TABLE public.promotional_draws
    ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ
  `);

  await dbQuery(client, `
    ALTER TABLE public.promotional_draws
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()
  `);

  await dbQuery(client, `
    ALTER TABLE public.promotional_draws
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()
  `);

  await dbQuery(client, `
    UPDATE public.promotional_draws
       SET price_cents = COALESCE(NULLIF(price_cents, 0), ticket_price_cents, promotional_price_cents, 5500),
           ticket_price_cents = COALESCE(ticket_price_cents, NULLIF(price_cents, 0), promotional_price_cents, 5500),
           promotional_price_cents = COALESCE(promotional_price_cents, NULLIF(price_cents, 0), ticket_price_cents, 5500),
           number_start = COALESCE(number_start, 0),
           number_end = COALESCE(number_end, 99),
           max_numbers_per_user = COALESCE(NULLIF(max_numbers_per_user, 0), 1),
           status = CASE
             WHEN status IS NULL OR TRIM(status) = '' THEN 'draft'
             WHEN LOWER(TRIM(status)) IN ('active', 'ativo', 'published', 'publicado', 'open', 'aberto') THEN 'active'
             WHEN LOWER(TRIM(status)) IN ('inactive', 'inativo', 'disabled', 'desativado') THEN 'inactive'
             WHEN LOWER(TRIM(status)) IN ('closed', 'fechado', 'ended', 'finalizado') THEN 'closed'
             WHEN LOWER(TRIM(status)) IN ('draft', 'rascunho') THEN 'draft'
             ELSE 'draft'
           END,
           updated_at = COALESCE(updated_at, NOW())
  `);

  await dbQuery(client, `
    ALTER TABLE public.promotional_draws
    ALTER COLUMN price_cents SET DEFAULT 5500
  `);

  await dbQuery(client, `
    ALTER TABLE public.promotional_draws
    ALTER COLUMN ticket_price_cents SET DEFAULT 5500
  `);

  await dbQuery(client, `
    ALTER TABLE public.promotional_draws
    ALTER COLUMN promotional_price_cents SET DEFAULT 5500
  `);

  await dbQuery(client, `
    ALTER TABLE public.promotional_draws
    ALTER COLUMN status SET DEFAULT 'draft'
  `);

  await dbQuery(client, `
    DO $$
    DECLARE
      r RECORD;
    BEGIN
      FOR r IN
        SELECT c.conname
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = 'public'
           AND t.relname = 'promotional_draws'
           AND c.contype = 'c'
           AND pg_get_constraintdef(c.oid) ILIKE '%status%'
      LOOP
        EXECUTE format(
          'ALTER TABLE public.promotional_draws DROP CONSTRAINT IF EXISTS %I',
          r.conname
        );
      END LOOP;
    END $$;
  `);

  await dbQuery(client, `
    ALTER TABLE public.promotional_draws
    ADD CONSTRAINT promotional_draws_status_check
    CHECK (
      LOWER(TRIM(status)) IN (
        'draft',
        'active',
        'inactive',
        'closed',
        'published',
        'open'
      )
    )
  `);

  console.log("[PROMOTIONAL_DRAWS_SCHEMA_OK] promotional_draws compatible");
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
      reservation_id UUID UNIQUE,
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
      preference_id TEXT,
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
      number TEXT,
      label TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'available',
      user_id INTEGER,
      reservation_id UUID REFERENCES public.promotional_reservations(id) ON DELETE SET NULL,
      reserved_by TEXT,
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
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS reservation_id UUID NULL`);
  await dbQuery(client, `
    UPDATE public.promotional_reservations
       SET reservation_id = CASE
         WHEN id::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           THEN id::text::uuid
         ELSE gen_random_uuid()
       END
     WHERE reservation_id IS NULL
  `);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending'`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS payment_id TEXT NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS preference_id TEXT NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS payment_provider TEXT NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS price_cents INTEGER NOT NULL DEFAULT 0`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS total_cents INTEGER NOT NULL DEFAULT 0`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS amount_cents INTEGER NOT NULL DEFAULT 0`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'public'`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS pix_qr_code TEXT NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS pix_qr_code_base64 TEXT NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS pix_copy_paste TEXT NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS pix_ticket_url TEXT NULL`);
  await dbQuery(client, `
    DO $$
    DECLARE
      id_type text;
    BEGIN
      SELECT udt_name
        INTO id_type
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'promotional_reservations'
         AND column_name = 'id';

      IF id_type = 'uuid' THEN
        ALTER TABLE public.promotional_reservations ALTER COLUMN id SET DEFAULT gen_random_uuid();
      END IF;
    END $$;
  `);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS user_id INTEGER NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS n INTEGER NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS number TEXT NULL`);
  await dbQuery(client, `
    DO $$
    DECLARE
      number_type text;
    BEGIN
      SELECT udt_name
        INTO number_type
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'promotional_numbers'
         AND column_name = 'number';

      IF number_type IS NOT NULL AND number_type <> 'text' THEN
        ALTER TABLE public.promotional_numbers
          ALTER COLUMN number TYPE TEXT
          USING number::text;
      END IF;
    END $$;
  `);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS number_value INTEGER NULL`);
  await dbQuery(client, `UPDATE public.promotional_numbers SET n = COALESCE(number_value, NULLIF(regexp_replace(number::text, '\\D', '', 'g'), '')::integer) WHERE n IS NULL AND COALESCE(number_value, NULLIF(regexp_replace(number::text, '\\D', '', 'g'), '')::integer) IS NOT NULL`);
  await dbQuery(client, `UPDATE public.promotional_numbers SET number = LPAD(COALESCE(n, number_value)::text, 2, '0') WHERE (number IS NULL OR number = '') AND COALESCE(n, number_value) IS NOT NULL`);
  await dbQuery(client, `UPDATE public.promotional_numbers SET number_value = COALESCE(n, NULLIF(regexp_replace(number::text, '\\D', '', 'g'), '')::integer) WHERE number_value IS NULL AND COALESCE(n, NULLIF(regexp_replace(number::text, '\\D', '', 'g'), '')::integer) IS NOT NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS label TEXT`);
  await dbQuery(client, `UPDATE public.promotional_numbers SET label = COALESCE(label, number_value::text, n::text, number::text) WHERE label IS NULL`);
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
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS reserved_by TEXT NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS buyer_name TEXT NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS buyer_email TEXT NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS buyer_phone TEXT NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMPTZ NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS reserved_until TIMESTAMPTZ NULL`);

  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS payment_provider TEXT NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS payment_id TEXT NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS preference_id TEXT NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending'`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);

  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS payment_id TEXT NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending'`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS sold_at TIMESTAMPTZ NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS reserved_until TIMESTAMPTZ NULL`);
  await dbQuery(client, `ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);

  await dbQuery(client, `
    CREATE INDEX IF NOT EXISTS promotional_reservations_payment_id_idx
    ON public.promotional_reservations(payment_id)
  `);
  await dbQuery(client, `
    CREATE INDEX IF NOT EXISTS promotional_reservations_reservation_id_idx
    ON public.promotional_reservations(reservation_id)
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
    CREATE INDEX IF NOT EXISTS promotional_numbers_draw_number_idx
    ON public.promotional_numbers(draw_id, number)
  `);
  await dbQuery(client, `
    CREATE INDEX IF NOT EXISTS promotional_payments_payment_id_idx
    ON public.promotional_payments(payment_id)
  `);
  await dbQuery(client, `
    CREATE INDEX IF NOT EXISTS promotional_payments_reservation_idx
    ON public.promotional_payments(reservation_id)
  `);

  await ensurePromotionalDrawCompatibility(client);
  await ensurePromotionalRuntimeConstraints(client);
}

export async function releaseExpiredPromotionalReservations(client = null, drawId = null) {
  const db = getDbRunner(client);
  const params = [];
  let drawFilter = "";
  if (drawId != null && drawId !== "") {
    params.push(Number(drawId));
    drawFilter = `AND pr.draw_id = $${params.length}`;
  }

  await db.query(`
    UPDATE public.promotional_numbers pn
       SET status = 'available',
           reservation_id = NULL,
           reserved_by = NULL,
           buyer_email = NULL,
           buyer_name = NULL,
           buyer_phone = NULL,
           user_id = NULL,
           payment_id = NULL,
           payment_status = 'pending',
           reserved_at = NULL,
           expires_at = NULL,
           reserved_until = NULL,
           updated_at = NOW()
     WHERE LOWER(COALESCE(pn.status, 'available')) = 'reserved'
       AND COALESCE(pn.expires_at, pn.reserved_until) IS NOT NULL
       AND COALESCE(pn.expires_at, pn.reserved_until) <= NOW()
       AND NOT EXISTS (
         SELECT 1
           FROM public.promotional_reservations pr
          WHERE (pr.id::TEXT = pn.reservation_id::TEXT OR pr.reservation_id::TEXT = pn.reservation_id::TEXT)
            AND LOWER(COALESCE(pr.payment_status, 'pending')) IN ('paid', 'approved', 'pago')
       )
  `);

  const result = await db.query(`
    WITH expired AS (
      UPDATE public.promotional_reservations pr
         SET status = 'expired',
             payment_status = 'expired',
             updated_at = NOW()
       WHERE pr.status IN ('reserved', 'pending')
         AND COALESCE(pr.payment_status, 'pending') IN ('pending', 'waiting', 'open')
         AND pr.expires_at IS NOT NULL
         AND pr.expires_at < NOW()
         ${drawFilter}
       RETURNING pr.id, pr.reservation_id, pr.draw_id
    )
    UPDATE public.promotional_numbers pn
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
      FROM expired e
     WHERE pn.draw_id = e.draw_id
       AND pn.reservation_id::text IN (e.reservation_id::text, e.id::text)
       AND pn.status = 'reserved'
       AND COALESCE(pn.payment_status, 'pending') NOT IN ('paid', 'approved', 'pago')
  `, params);
  return Number(result.rowCount || 0);
}

export async function expirePromotionalReservations(drawId = null) {
  await ensurePromotionalSchema();
  const pool = await getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const expired = await releaseExpiredPromotionalReservations(client, drawId);
    await client.query("COMMIT");
    return {
      ok: true,
      expired,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[promotional.expireReservations] error:", {
      message: error?.message,
      code: error?.code,
      detail: error?.detail,
      stack: error?.stack,
    });
    throw error;
  } finally {
    client.release();
  }
}

function drawSelect() {
  return `
    SELECT
      d.*,
      COALESCE(ns.total_numbers, 0)::int AS total_numbers,
      COALESCE(ns.available_numbers, 0)::int AS available_numbers,
      COALESCE(ns.reserved_numbers, 0)::int AS reserved_numbers,
      COALESCE(ns.sold_numbers, 0)::int AS sold_numbers,
      COALESCE(ns.blocked_numbers, 0)::int AS blocked_numbers
    FROM public.promotional_draws d
    LEFT JOIN (
      SELECT
        draw_id,
        COUNT(*)::int AS total_numbers,
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(status, 'available')) = 'available'
        )::int AS available_numbers,
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(status, 'available')) IN ('reserved', 'pending')
        )::int AS reserved_numbers,
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(status, 'available')) IN ('sold', 'paid', 'approved')
        )::int AS sold_numbers,
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(status, 'available')) IN ('blocked', 'unavailable')
        )::int AS blocked_numbers
      FROM public.promotional_numbers
      GROUP BY draw_id
    ) ns ON ns.draw_id = d.id
  `;
}

function normalizeNumberRow(row) {
  const value = row.n ?? row.number_value ?? Number(row.number);
  return {
    ...row,
    n: Number(value),
    number: Number(value),
    number_value: Number(value),
    label: row.label || formatPromotionalNumber(value),
    available: row.status === "available",
  };
}

function mapAdminNumberRow(row) {
  if (!row) return null;
  const value = row.n ?? row.number_value ?? Number(row.number);
  return {
    id: Number(row.id),
    draw_id: Number(row.draw_id),
    n: Number(value),
    number: Number(value),
    number_value: Number(value),
    label: row.label || formatPromotionalNumber(value),
    status: row.status,
    user_id: row.user_id != null ? Number(row.user_id) : null,
    reservation_id: row.reservation_id != null ? String(row.reservation_id) : null,
    reserved_by: row.reserved_by ?? null,
    buyer_name: row.buyer_name ?? null,
    buyer_email: row.buyer_email ?? null,
    buyer_phone: row.buyer_phone ?? null,
    payment_status: row.payment_status ?? "pending",
    payment_id: row.payment_id ?? null,
    reserved_at: row.reserved_at ?? null,
    reserved_until: row.reserved_until ?? row.expires_at ?? null,
    expires_at: row.expires_at ?? row.reserved_until ?? null,
    sold_at: row.sold_at ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

export async function listActivePromotionalDraws() {
  await ensurePromotionalSchema();
  await releaseExpiredPromotionalReservations();

  const { rows } = await query(`
    ${drawSelect()}
    WHERE LOWER(COALESCE(d.status, 'draft')) IN ('active', 'published', 'open')
      AND (d.starts_at IS NULL OR d.starts_at <= NOW())
      AND (d.ends_at IS NULL OR d.ends_at >= NOW())
    ORDER BY d.created_at DESC NULLS LAST, d.id DESC
  `);

  return rows;
}

export async function listPromotionalDraws() {
  await ensurePromotionalAdminSchema();

  if (typeof releaseExpiredPromotionalReservations === "function") {
    await releaseExpiredPromotionalReservations().catch((err) => {
      console.warn("[PROMOTIONAL_ADMIN_RELEASE_EXPIRED_WARN]", {
        code: err?.code,
        message: err?.message,
      });
    });
  }

  const { rows } = await query(`
    ${drawSelect()}
    WHERE d.archived_at IS NULL
    ORDER BY COALESCE(d.updated_at, d.created_at, NOW()) DESC, d.id DESC
  `);

  return rows;
}

export async function getPromotionalDrawById(id) {
  await ensurePromotionalAdminSchema();

  const drawId = Number.parseInt(id, 10);
  if (!Number.isInteger(drawId) || drawId <= 0) {
    return null;
  }

  const { rows } = await query(`
    ${drawSelect()}
    WHERE d.id = $1
    LIMIT 1
  `, [drawId]);

  return rows[0] || null;
}

export async function getPromotionalNumbers(draw_id, client = null) {
  await ensurePromotionalSchema(client);
  await releaseExpiredPromotionalReservations(client);
  const { rows } = await dbQuery(client, `
    SELECT *
    FROM public.promotional_numbers
    WHERE draw_id = $1
    ORDER BY COALESCE(n, number_value, NULLIF(regexp_replace(number::text, '\\D', '', 'g'), '')::integer) ASC
  `, [draw_id]);
  return rows.map(normalizeNumberRow);
}

export async function getPromotionalNumbersAdmin(draw_id, client = null) {
  await ensurePromotionalSchema(client);
  await releaseExpiredPromotionalReservations(client);
  const { rows } = await dbQuery(client, `
    SELECT
      id,
      draw_id,
      COALESCE(n, number_value, NULLIF(regexp_replace(number::text, '\\D', '', 'g'), '')::integer) AS n,
      COALESCE(number, LPAD(COALESCE(n, number_value)::text, 2, '0')) AS number,
      COALESCE(number_value, n, NULLIF(regexp_replace(number::text, '\\D', '', 'g'), '')::integer) AS number_value,
      label,
      status,
      user_id,
      reservation_id,
      reserved_by,
      buyer_name,
      buyer_email,
      buyer_phone,
      payment_status,
      payment_id,
      reserved_at,
      reserved_until,
      expires_at,
      sold_at,
      created_at,
      updated_at
    FROM public.promotional_numbers
    WHERE draw_id = $1
    ORDER BY COALESCE(n, number_value, NULLIF(regexp_replace(number::text, '\\D', '', 'g'), '')::integer) ASC
  `, [draw_id]);
  return rows.map(mapAdminNumberRow);
}

export async function createPromotionalDraw(data, client = null) {
  await ensurePromotionalAdminSchema(client);

  const title = String(data?.title || data?.name || "").trim();
  const description = String(data?.description || "").trim();
  const prize = String(data?.prize || data?.award || "").trim();

  if (!title) {
    const err = new Error("Título do sorteio promocional é obrigatório.");
    err.status = 400;
    err.code = "promotional_draw_title_required";
    throw err;
  }

  const priceCents = Math.max(
    1,
    parsePromotionalInt(
      data?.price_cents ?? data?.ticket_price_cents ?? data?.promotional_price_cents,
      5500
    )
  );

  const numberStart = parsePromotionalInt(data?.number_start, 0);
  const numberEnd = parsePromotionalInt(data?.number_end, 99);
  const maxNumbersPerUser = Math.max(1, parsePromotionalInt(data?.max_numbers_per_user, 1));
  const status = normalizePromotionalAdminStatus(data?.status);
  const bannerUrl = data?.banner_url ? String(data.banner_url).trim() : null;
  const startsAt = data?.starts_at || data?.start_at || null;
  const endsAt = data?.ends_at || data?.end_at || null;

  if (
    !Number.isInteger(numberStart) ||
    !Number.isInteger(numberEnd) ||
    numberStart < 0 ||
    numberEnd < numberStart ||
    numberEnd > 1000
  ) {
    const err = new Error("Intervalo de números promocionais inválido.");
    err.status = 400;
    err.code = "invalid_promotional_number_range";
    throw err;
  }

  const { rows } = await dbQuery(client, `
    INSERT INTO public.promotional_draws (
      title,
      description,
      prize,
      price_cents,
      ticket_price_cents,
      promotional_price_cents,
      number_start,
      number_end,
      max_numbers_per_user,
      status,
      banner_url,
      starts_at,
      ends_at,
      created_at,
      updated_at
    )
    VALUES (
      $1::text,
      $2::text,
      $3::text,
      $4::int,
      $4::int,
      $4::int,
      $5::int,
      $6::int,
      $7::int,
      $8::text,
      $9::text,
      NULLIF($10::text, '')::timestamptz,
      NULLIF($11::text, '')::timestamptz,
      NOW(),
      NOW()
    )
    RETURNING *
  `, [
    title,
    description,
    prize,
    priceCents,
    numberStart,
    numberEnd,
    maxNumbersPerUser,
    status,
    bannerUrl,
    startsAt || "",
    endsAt || "",
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

  const normalizedDrawId = Number.parseInt(draw_id, 10);
  const start = Number.parseInt(number_start, 10);
  const end = Number.parseInt(number_end, 10);

  if (
    !Number.isInteger(normalizedDrawId) ||
    !Number.isInteger(start) ||
    !Number.isInteger(end)
  ) {
    return [];
  }

  if (start < 0 || end < start) {
    return [];
  }

  const { rows } = await dbQuery(
    client,
    `
      WITH generated AS (
        SELECT
          $1::int AS draw_id,
          gs::int AS n,
          gs::int AS number_value,
          LPAD(gs::text, 2, '0')::text AS number,
          LPAD(gs::text, 2, '0')::text AS label,
          'available'::text AS status
        FROM generate_series($2::int, $3::int) AS gs
      )
      INSERT INTO public.promotional_numbers (
        draw_id,
        n,
        number_value,
        number,
        label,
        status,
        created_at,
        updated_at
      )
      SELECT
        g.draw_id,
        g.n,
        g.number_value,
        g.number,
        g.label,
        g.status,
        NOW(),
        NOW()
      FROM generated g
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.promotional_numbers pn
        WHERE pn.draw_id = g.draw_id
          AND COALESCE(
            pn.n,
            pn.number_value,
            NULLIF(regexp_replace(pn.number::text, '\\D', '', 'g'), '')::int
          ) = g.n
      )
      ON CONFLICT DO NOTHING
      RETURNING *
    `,
    [normalizedDrawId, start, end]
  );

  return rows.map(normalizeNumberRow);
}

export async function updatePromotionalNumberStatus(draw_id, n, status) {
  await ensurePromotionalSchema();
  const s = String(status || "").toLowerCase();

  let sql;
  const params = [Number.parseInt(draw_id, 10), Number.parseInt(n, 10)];

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
        expires_at = NULL,
        reserved_until = NULL,
        sold_at = NULL,
        updated_at = NOW()
      WHERE draw_id = $1::int AND COALESCE(n::int, number_value::int, NULLIF(regexp_replace(number::text, '\\D', '', 'g'), '')::integer) = $2::int
      RETURNING *
    `;
  } else if (s === "sold") {
    sql = `
      UPDATE public.promotional_numbers
      SET
        status = 'sold',
        sold_at = NOW(),
        updated_at = NOW()
      WHERE draw_id = $1::int AND COALESCE(n::int, number_value::int, NULLIF(regexp_replace(number::text, '\\D', '', 'g'), '')::integer) = $2::int
      RETURNING *
    `;
  } else if (s === "reserved") {
    sql = `
      UPDATE public.promotional_numbers
      SET
        status = 'reserved',
        reserved_at = COALESCE(reserved_at, NOW()),
        updated_at = NOW()
      WHERE draw_id = $1::int AND COALESCE(n::int, number_value::int, NULLIF(regexp_replace(number::text, '\\D', '', 'g'), '')::integer) = $2::int
      RETURNING *
    `;
  } else if (s === "blocked") {
    sql = `
      UPDATE public.promotional_numbers
      SET
        status = 'blocked',
        updated_at = NOW()
      WHERE draw_id = $1::int AND COALESCE(n::int, number_value::int, NULLIF(regexp_replace(number::text, '\\D', '', 'g'), '')::integer) = $2::int
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
  await releaseExpiredPromotionalReservations();
  const { rows } = await query(`
    SELECT
      COALESCE(r.reservation_id::text, r.id::text) AS reservation_id,
      r.user_id,
      r.buyer_name,
      r.buyer_email,
      r.buyer_phone,
      r.numbers,
      r.status,
      r.payment_status,
      r.payment_id,
      r.source,
      r.created_at,
      r.expires_at
    FROM public.promotional_reservations r
    WHERE r.draw_id = $1
    ORDER BY r.created_at DESC
  `, [draw_id]);

  return rows.map((row) => {
    const source = String(row.source || "").toLowerCase();
    const isAdmin = source === "admin";
    return {
      ...row,
      name: row.buyer_name,
      email: row.buyer_email,
      phone: row.buyer_phone,
      source: row.source || null,
      source_label: isAdmin ? "Atribuído pelo admin" : "Origem antiga",
      status_label: isAdmin ? "Atribuído pelo admin" : mapReservationStatusLabel(row.status),
    };
  });
}

function mapReservationStatusLabel(status) {
  const normalized = String(status || "reserved").toLowerCase();
  if (normalized === "paid" || normalized === "approved") return "PAGO";
  if (normalized === "pending") return "PENDENTE";
  if (normalized === "expired") return "EXPIRADO";
  if (normalized === "cancelled" || normalized === "canceled") return "CANCELADO";
  return "RESERVADO";
}

export async function countPromotionalNumbersByContact(draw_id, email, phone, user_id = null) {
  await ensurePromotionalSchema();
  await releaseExpiredPromotionalReservations();
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
  await releaseExpiredPromotionalReservations();
  const { rows } = await query(`
    SELECT
      COALESCE(r.reservation_id::text, r.id::text) AS reservation_id,
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
      r.source,
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

export async function getPromotionalAssignmentForUser(drawId, user = null) {
  await ensurePromotionalSchema();
  await releaseExpiredPromotionalReservations();

  const normalizedDrawId = Number.parseInt(drawId, 10);
  const userId = Number.parseInt(user?.id, 10);
  const userEmail = String(user?.email || "").trim();

  if (!Number.isInteger(normalizedDrawId) || normalizedDrawId <= 0) {
    const err = new Error("ID do sorteio promocional inválido.");
    err.status = 400;
    err.code = "invalid_promotional_draw";
    throw err;
  }

  if (!Number.isInteger(userId) || !userEmail) {
    const err = new Error("Usuário não autenticado.");
    err.status = 401;
    err.code = "login_required";
    throw err;
  }

  const { rows } = await query(`
    SELECT
      COALESCE(r.reservation_id::text, r.id::text) AS reservation_id,
      r.draw_id,
      r.user_id,
      r.numbers,
      r.buyer_name,
      r.buyer_email,
      r.buyer_phone,
      r.status,
      r.payment_status,
      r.source,
      r.created_at,
      d.title AS draw_title
    FROM public.promotional_reservations r
    JOIN public.promotional_draws d ON d.id = r.draw_id
    WHERE r.draw_id = $1
      AND (
        r.user_id = $2
        OR LOWER(r.buyer_email) = LOWER($3)
      )
      AND LOWER(COALESCE(r.status, '')) NOT IN ('cancelled', 'canceled', 'expired')
    ORDER BY
      CASE WHEN LOWER(COALESCE(r.source, '')) = 'admin' THEN 0 ELSE 1 END,
      r.created_at DESC
    LIMIT 1
  `, [normalizedDrawId, userId, userEmail]);

  if (!rows.length) {
    return {
      has_assignment: false,
      numbers: [],
      message: "Você ainda não possui número atribuído neste sorteio promocional.",
    };
  }

  const row = rows[0];
  const numbers = Array.isArray(row.numbers) ? row.numbers.map(Number) : [];
  const source = String(row.source || "admin").toLowerCase() === "admin" ? "admin" : String(row.source || "public");
  const isAdmin = source === "admin" || String(row.payment_status || "").toLowerCase() === "approved";

  return {
    has_assignment: true,
    draw_id: normalizedDrawId,
    draw_title: row.draw_title || "",
    reservation_id: row.reservation_id,
    source: isAdmin ? "admin" : source,
    status: row.status || "reserved",
    status_label: isAdmin ? "Atribuído pelo admin" : mapReservationStatusLabel(row.status),
    payment_status: row.payment_status || (isAdmin ? "approved" : "pending"),
    payment_label: isAdmin ? "Sem pagamento necessário" : "Pendente",
    can_pay: false,
    numbers,
    numbers_label: numbers.map((n) => String(n).padStart(2, "0")).join(", "),
    buyer_name: row.buyer_name || "",
    buyer_email: row.buyer_email || "",
    buyer_phone: row.buyer_phone || "",
    created_at: row.created_at,
    draw: {
      id: normalizedDrawId,
      title: row.draw_title || "",
    },
    reservation: row,
  };
}

export async function getPromotionalReservationForPayment(draw_id, reservation_id, user_id = null) {
  await ensurePromotionalSchema();
  await releaseExpiredPromotionalReservations(null, draw_id);
  const { rows } = await query(`
    SELECT
      COALESCE(r.reservation_id::text, r.id::text) AS reservation_id,
      r.id,
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
    WHERE (r.id::text = $1::text OR r.reservation_id::text = $1::text)
      AND r.draw_id = $2
      AND ($3::integer IS NULL OR r.user_id = $3::integer)
    LIMIT 1
  `, [String(reservation_id), draw_id, user_id]);
  return rows[0] || null;
}

export async function attachPromotionalPixPayment(draw_id, reservation_id, pix) {
  await ensurePromotionalSchema();
  const paymentId = typeof pix === "object" ? pix.payment_id : pix;
  const preferenceId = typeof pix === "object" ? pix.preference_id : null;
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
        preference_id = COALESCE($7, preference_id),
        payment_status = 'pending',
        status = 'reserved',
        payment_provider = 'mercadopago',
        pix_qr_code = $4,
        pix_qr_code_base64 = $5,
        pix_copy_paste = $4,
        pix_ticket_url = $6,
        updated_at = NOW()
    WHERE (id::text = $1::text OR reservation_id::text = $1::text)
      AND draw_id = $2
  `, [String(reservation_id), draw_id, paymentId, qrCode, qrCodeBase64, ticketUrl, preferenceId]);

  await query(`
    UPDATE public.promotional_numbers
    SET payment_id = $3,
        payment_status = 'pending',
        status = 'reserved',
        updated_at = NOW()
    WHERE draw_id = $1
      AND reservation_id::text = $2::text
  `, [draw_id, String(reservation_id), paymentId]);

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
    WHERE (r.id::text = $1::text OR r.reservation_id::text = $1::text)
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
    String(reservation_id),
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

export async function attachPaymentToPromotionalReservation({
  reservationId,
  paymentId = null,
  preferenceId = null,
  pixQrCode = null,
  pixQrCodeBase64 = null,
  pixTicketUrl = null,
} = {}) {
  await ensurePromotionalSchema();
  const result = await query(
    `
    UPDATE public.promotional_reservations
    SET payment_id = COALESCE($2, payment_id),
        preference_id = COALESCE($3, preference_id),
        payment_provider = COALESCE(payment_provider, 'mercadopago'),
        payment_status = 'pending',
        status = 'reserved',
        pix_qr_code = COALESCE($4, pix_qr_code),
        pix_qr_code_base64 = COALESCE($5, pix_qr_code_base64),
        pix_copy_paste = COALESCE($4, pix_copy_paste),
        pix_ticket_url = COALESCE($6, pix_ticket_url),
        updated_at = NOW()
    WHERE id::text = $1::text OR reservation_id::text = $1::text
    RETURNING *
    `,
    [
      String(reservationId || ""),
      paymentId,
      preferenceId,
      pixQrCode,
      pixQrCodeBase64,
      pixTicketUrl,
    ]
  );

  const reservation = result.rows[0] || null;
  if (reservation) {
    await query(
      `
      UPDATE public.promotional_numbers
      SET payment_id = COALESCE($2, payment_id),
          payment_status = 'pending',
          status = 'reserved',
          updated_at = NOW()
      WHERE reservation_id::text = $1::text
      `,
      [String(reservation.reservation_id || reservation.id), paymentId]
    );
  }

  return reservation;
}

export async function createPromotionalReservation({
  drawId,
  userId,
  numbers,
  user = null,
  buyer = null,
  buyerName = "",
  buyerEmail = "",
  buyerPhone = "",
  source = "public",
} = {}) {
  const pool = await getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await ensurePromotionalSchema(client);
    await releaseExpiredPromotionalReservations(client, drawId);

    const normalizedDrawId = Number.parseInt(drawId, 10);
    const resolvedUserId = userId ?? user?.id ?? buyer?.user_id;
    const normalizedUserId = Number.parseInt(resolvedUserId, 10);

    if (!Number.isFinite(normalizedDrawId)) {
      const err = new Error("Sorteio promocional inválido.");
      err.status = 400;
      err.statusCode = 400;
      err.code = "invalid_promotional_draw";
      throw err;
    }

    if (!Number.isFinite(normalizedUserId)) {
      const err = new Error("Usuário inválido.");
      err.status = 401;
      err.statusCode = 401;
      err.code = "login_required";
      throw err;
    }

    const drawResult = await client.query(`
      SELECT
        id,
        title,
        price_cents,
        status,
        number_start,
        number_end
      FROM public.promotional_draws
      WHERE id = $1::int
        AND archived_at IS NULL
      FOR UPDATE
    `, [normalizedDrawId]);

    if (!drawResult.rowCount) {
      const err = new Error("Sorteio promocional não encontrado.");
      err.status = 404;
      err.code = "promotional_draw_not_found";
      throw err;
    }

    const draw = drawResult.rows[0];
    if (!["active", "open", "published"].includes(String(draw.status || "").toLowerCase())) {
      const err = new Error("Sorteio promocional não está aberto.");
      err.status = 400;
      err.code = "promotional_draw_closed";
      throw err;
    }

    const cleanNumbers = [...new Set(
      (numbers || [])
        .map((n) => Number.parseInt(n, 10))
        .filter((n) => Number.isInteger(n) && n >= 0)
    )];
    if (!cleanNumbers.length) {
      const err = new Error("Selecione ao menos um número.");
      err.status = 400;
      err.code = "invalid_number";
      throw err;
    }

    const start = Number.parseInt(draw.number_start ?? 0, 10);
    const end = Number.parseInt(draw.number_end ?? 99, 10);
    const outOfRange = cleanNumbers.filter((n) => n < start || n > end);
    if (outOfRange.length) {
      const err = new Error("Número fora do intervalo do sorteio promocional.");
      err.status = 400;
      err.code = "invalid_number";
      err.conflicts = outOfRange;
      throw err;
    }

    const resolvedBuyerName = buyerName || buyer?.buyer_name || buyer?.name || user?.name || user?.nome || "";
    const resolvedBuyerEmail = buyerEmail || buyer?.buyer_email || buyer?.email || user?.email || "";
    const resolvedBuyerPhone = buyerPhone || buyer?.buyer_phone || buyer?.phone || user?.phone || "";
    const priceCents = Number.parseInt(draw.price_cents, 10);
    const amountCents = priceCents * cleanNumbers.length;
    if (!Number.isFinite(priceCents) || priceCents <= 0 || amountCents <= 0) {
      const err = new Error("Sorteio promocional sem valor configurado. Defina o valor no admin.");
      err.status = 400;
      err.code = "promotional_amount_invalid";
      throw err;
    }

    await createPromotionalNumbers(normalizedDrawId, start, end, client);

    const locked = await client.query(`
      SELECT
        id,
        COALESCE(n, number_value, NULLIF(regexp_replace(number::text, '\\D', '', 'g'), '')::integer) AS number,
        status,
        payment_status,
        reservation_id,
        COALESCE(expires_at, reserved_until) AS expires_at
      FROM public.promotional_numbers
      WHERE draw_id = $1::int
        AND COALESCE(
          n::int,
          number_value::int,
          NULLIF(regexp_replace(number::text, '\\D', '', 'g'), '')::integer
        ) = ANY($2::int[])
      ORDER BY COALESCE(
        n::int,
        number_value::int,
        NULLIF(regexp_replace(number::text, '\\D', '', 'g'), '')::integer
      ) ASC
      FOR UPDATE
    `, [normalizedDrawId, cleanNumbers]);

    const found = new Set(locked.rows.map((row) => Number(row.number)));
    const missing = cleanNumbers.filter((n) => !found.has(n));
    if (missing.length) {
      const err = new Error("Um ou mais números já estão reservados.");
      err.status = 409;
      err.code = "PROMOTIONAL_NUMBER_ALREADY_RESERVED";
      err.conflicts = missing;
      throw err;
    }

    const conflicts = locked.rows
      .filter((row) => {
        const status = String(row.status || "").toLowerCase();
        const paymentStatus = String(row.payment_status || "").toLowerCase();
        const activeReservation = row.reservation_id && row.expires_at && new Date(row.expires_at).getTime() > Date.now();
        return (
          ["reserved", "sold", "blocked", "unavailable", "pending"].includes(status) ||
          ["paid", "approved", "pago"].includes(paymentStatus) ||
          activeReservation
        );
      })
      .map((row) => Number(row.number));
    if (conflicts.length) {
      const used = conflicts.map((n) => String(n).padStart(2, "0"));
      const err = new Error(`Número(s) já reservado(s): ${used.join(", ")}`);
      err.status = 409;
      err.statusCode = 409;
      err.code = "PROMOTIONAL_NUMBER_ALREADY_RESERVED";
      err.conflicts = conflicts;
      throw err;
    }

    const reservationId = randomUUID();
    const expiresAt = new Date(Date.now() + PROMOTIONAL_RESERVATION_TTL_MINUTES * 60 * 1000);

    await ensurePromotionalRuntimeConstraints(client);

    const idUsesUuid = await promotionalReservationIdUsesUuid(client);

    let reservation;

    if (idUsesUuid) {
      reservation = await client.query(
        `
        INSERT INTO public.promotional_reservations (
          id,
          reservation_id,
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
        VALUES (
          $1,
          $1,
          $2,
          $3,
          $4::int[],
          $5,
          $6,
          $7,
          $8,
          $9,
          $9,
          $10,
          'reserved',
          'pending',
          $11,
          NOW(),
          NOW()
        )
        RETURNING *
        `,
        [
          reservationId,
          normalizedDrawId,
          normalizedUserId,
          cleanNumbers,
          resolvedBuyerName || resolvedBuyerEmail || "",
          resolvedBuyerEmail || "",
          resolvedBuyerPhone || "",
          priceCents,
          amountCents,
          source,
          expiresAt,
        ]
      );
    } else {
      reservation = await client.query(
        `
        INSERT INTO public.promotional_reservations (
          reservation_id,
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
        VALUES (
          $1,
          $2,
          $3,
          $4::int[],
          $5,
          $6,
          $7,
          $8,
          $9,
          $9,
          $10,
          'reserved',
          'pending',
          $11,
          NOW(),
          NOW()
        )
        RETURNING *
        `,
        [
          reservationId,
          normalizedDrawId,
          normalizedUserId,
          cleanNumbers,
          resolvedBuyerName || resolvedBuyerEmail || "",
          resolvedBuyerEmail || "",
          resolvedBuyerPhone || "",
          priceCents,
          amountCents,
          source,
          expiresAt,
        ]
      );
    }

    console.log("[PROMOTIONAL_RESERVATION_CREATED]", {
      reservationId: reservation.rows[0]?.reservation_id || reservation.rows[0]?.id,
      drawId: normalizedDrawId,
      userId: normalizedUserId,
      numbers: cleanNumbers,
      status: reservation.rows[0]?.status,
      paymentStatus: reservation.rows[0]?.payment_status,
    });

    let updateResult;
    try {
      updateResult = await client.query(`
        UPDATE public.promotional_numbers
        SET
          status = 'reserved',
          n = COALESCE(n, number_value, NULLIF(regexp_replace(number::text, '\\D', '', 'g'), '')::integer),
          number = COALESCE(number, LPAD(COALESCE(n, number_value)::text, 2, '0')),
          number_value = COALESCE(number_value, n, NULLIF(regexp_replace(number::text, '\\D', '', 'g'), '')::integer),
          reservation_id = $1,
          reserved_by = $2,
          user_id = $3,
          buyer_name = $4,
          buyer_email = $5,
          buyer_phone = $6,
          payment_status = 'pending',
          payment_id = NULL,
          reserved_at = NOW(),
          expires_at = $7,
          reserved_until = $7,
          updated_at = NOW()
        WHERE draw_id = $8::int
          AND COALESCE(
            n::int,
            number_value::int,
            NULLIF(regexp_replace(number::text, '\\D', '', 'g'), '')::integer
          ) = ANY($9::int[])
          AND (
            LOWER(COALESCE(status, 'available')) = 'available'
            OR (
              LOWER(COALESCE(status, 'available')) = 'reserved'
              AND expires_at IS NOT NULL
              AND expires_at <= NOW()
            )
          )
          AND LOWER(COALESCE(payment_status, 'pending')) NOT IN ('paid', 'approved', 'pago')
      `, [
        reservation.rows[0].reservation_id || reservation.rows[0].id,
        String(normalizedUserId),
        normalizedUserId,
        resolvedBuyerName || resolvedBuyerEmail || "",
        resolvedBuyerEmail || "",
        resolvedBuyerPhone || null,
        reservation.rows[0].expires_at,
        normalizedDrawId,
        cleanNumbers,
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

    const expected = cleanNumbers.length;
    if (Number(updateResult.rowCount) < expected) {
      console.error("[PROMOTIONAL_RESERVE_NUMBER_UPDATE_ERROR]", {
        code: "ROWCOUNT_MISMATCH",
        message: `Esperado ao menos ${expected} linhas, atualizadas ${updateResult.rowCount}`,
        detail: { drawId, numbers: cleanNumbers },
        hint: null,
        stack: null,
      });
      const err = new Error("Alguns números promocionais não puderam ser reservados. Atualize a página e tente novamente.");
      err.status = 409;
      err.code = "PROMOTIONAL_NUMBER_ALREADY_RESERVED";
      throw err;
    }

    await client.query("COMMIT");
    const returnedReservationId = reservation.rows[0].reservation_id || reservation.rows[0].id;
    return {
      ok: true,
      reservation: reservation.rows[0],
      id: returnedReservationId,
      reservation_id: returnedReservationId,
      reservationId: returnedReservationId,
      draw_id: normalizedDrawId,
      drawId: normalizedDrawId,
      draw_title: draw.title || "",
      numbers: cleanNumbers,
      price_cents: priceCents,
      priceCents,
      amount_cents: amountCents,
      amountCents,
      expires_at: reservation.rows[0].expires_at,
      expiresAt: reservation.rows[0].expires_at,
      payment_status: "pending",
      paymentStatus: "pending",
      status: "reserved",
      can_pay: true,
      canPay: true,
    };
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

export async function reservePromotionalNumbers(draw_id, userOrPayload, numbers = null, buyer = {}) {
  const payload = userOrPayload && typeof userOrPayload === "object" && !Array.isArray(userOrPayload)
    ? userOrPayload
    : {
        user_id: userOrPayload,
        numbers,
        ...(buyer || {}),
      };

  const result = await createPromotionalReservation({
    drawId: draw_id,
    userId: payload.user_id,
    numbers: payload.numbers,
    buyerName: payload.name || payload.buyer_name,
    buyerEmail: payload.email || payload.buyer_email,
    buyerPhone: payload.phone || payload.buyer_phone,
    source: payload.source || "public",
  });

  return result;
}

export async function assignPromotionalNumbersToUser({
  drawId,
  userId,
  numbers,
  buyer = {},
  status = "reserved",
} = {}) {
  const pool = await getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await ensurePromotionalSchema(client);
    await releaseExpiredPromotionalReservations(client, drawId);

    const normalizedDrawId = Number.parseInt(drawId, 10);
    const normalizedUserId = Number.parseInt(userId, 10);
    const normalizedNumbers = [...new Set(
      (Array.isArray(numbers) ? numbers : [])
        .map((n) => Number.parseInt(n, 10))
        .filter((n) => Number.isInteger(n) && n >= 0)
    )];

    if (!Number.isInteger(normalizedDrawId) || normalizedDrawId <= 0) {
      const err = new Error("Sorteio promocional inválido.");
      err.status = 400;
      err.code = "invalid_promotional_assignment";
      throw err;
    }

    if (!Number.isInteger(normalizedUserId) || normalizedUserId <= 0) {
      const err = new Error("Usuário inválido para atribuição promocional.");
      err.status = 400;
      err.code = "invalid_promotional_assignment";
      throw err;
    }

    if (normalizedNumbers.length !== 1) {
      const err = new Error("Atribuição promocional permite exatamente 1 número por usuário.");
      err.status = 400;
      err.code = "invalid_promotional_assignment";
      throw err;
    }

    const drawResult = await client.query(`
      SELECT id, title, price_cents, number_start, number_end
      FROM public.promotional_draws
      WHERE id = $1
      LIMIT 1
    `, [normalizedDrawId]);

    if (!drawResult.rowCount) {
      const err = new Error("Sorteio promocional não encontrado.");
      err.status = 404;
      err.code = "promotional_draw_not_found";
      throw err;
    }

    const draw = drawResult.rows[0];
    const start = Number.parseInt(draw.number_start ?? 0, 10);
    const end = Number.parseInt(draw.number_end ?? 99, 10);
    const outsideRange = normalizedNumbers.filter((n) => n < start || n > end);
    if (outsideRange.length) {
      const err = new Error(`Número fora do intervalo permitido: ${start} até ${end}.`);
      err.status = 400;
      err.code = "invalid_number";
      err.conflicts = outsideRange;
      throw err;
    }

    const buyerName = String(buyer.buyer_name || buyer.name || "").trim();
    const buyerEmail = String(buyer.buyer_email || buyer.email || "").trim();
    const buyerPhone = String(buyer.buyer_phone || buyer.phone || "").trim();
    const finalStatus = String(status || "reserved").toLowerCase() === "unavailable" ? "unavailable" : "reserved";
    const priceCents = Number(draw.price_cents || 0);

    const existingUserReservation = await client.query(`
      SELECT id, reservation_id, numbers, status
      FROM public.promotional_reservations
      WHERE draw_id = $1
        AND (
          user_id = $2
          OR ($3 <> '' AND LOWER(buyer_email) = LOWER($3))
        )
        AND LOWER(COALESCE(status, '')) NOT IN ('cancelled', 'canceled', 'expired')
      LIMIT 1
    `, [normalizedDrawId, normalizedUserId, buyerEmail]);

    if (existingUserReservation.rowCount) {
      const err = new Error("Este usuário já possui número atribuído neste sorteio promocional.");
      err.status = 409;
      err.code = "promotional_user_already_has_number";
      throw err;
    }

    await createPromotionalNumbers(normalizedDrawId, start, end, client);

    const locked = await client.query(`
      SELECT
        id,
        COALESCE(n, number_value, NULLIF(regexp_replace(number::text, '\\D', '', 'g'), '')::integer) AS number,
        status,
        payment_status,
        reservation_id,
        COALESCE(expires_at, reserved_until) AS expires_at
      FROM public.promotional_numbers
      WHERE draw_id = $1::int
        AND COALESCE(
          n::int,
          number_value::int,
          NULLIF(regexp_replace(number::text, '\\D', '', 'g'), '')::integer
        ) = ANY($2::int[])
      ORDER BY COALESCE(
        n::int,
        number_value::int,
        NULLIF(regexp_replace(number::text, '\\D', '', 'g'), '')::integer
      ) ASC
      FOR UPDATE
    `, [normalizedDrawId, normalizedNumbers]);

    const found = new Set(locked.rows.map((row) => Number(row.number)));
    const missing = normalizedNumbers.filter((n) => !found.has(n));
    if (missing.length) {
      const err = new Error("Número promocional não encontrado neste sorteio.");
      err.status = 404;
      err.code = "invalid_number";
      err.conflicts = missing;
      throw err;
    }

    const conflicts = locked.rows
      .filter((row) => {
        const numberStatus = String(row.status || "").toLowerCase();
        const paymentStatus = String(row.payment_status || "").toLowerCase();
        const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : null;
        const activeReservation =
          row.reservation_id &&
          expiresAt &&
          Number.isFinite(expiresAt) &&
          expiresAt > Date.now();

        if (numberStatus === "available") return false;
        if (
          numberStatus === "reserved" &&
          !activeReservation &&
          !["paid", "approved", "pago"].includes(paymentStatus)
        ) {
          return false;
        }

        return (
          ["reserved", "sold", "blocked", "unavailable", "pending"].includes(numberStatus) ||
          ["paid", "approved", "pago"].includes(paymentStatus) ||
          activeReservation
        );
      })
      .map((row) => Number(row.number));

    if (conflicts.length) {
      const used = conflicts.map((n) => String(n).padStart(2, "0"));
      const err = new Error(`Número(s) indisponível(is): ${used.join(", ")}`);
      err.status = 409;
      err.statusCode = 409;
      err.code = "PROMOTIONAL_NUMBER_ALREADY_RESERVED";
      err.conflicts = conflicts;
      throw err;
    }

    const reservationId = randomUUID();
    const idUsesUuid = await promotionalReservationIdUsesUuid(client);
    let reservationResult;

    if (idUsesUuid) {
      reservationResult = await client.query(
        `
        INSERT INTO public.promotional_reservations (
          id,
          reservation_id,
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
        VALUES (
          $1,
          $1,
          $2,
          $3,
          $4::int[],
          $5,
          $6,
          $7,
          $8,
          0,
          0,
          'admin',
          $9,
          'approved',
          NULL,
          NOW(),
          NOW()
        )
        RETURNING *
        `,
        [
          reservationId,
          normalizedDrawId,
          normalizedUserId,
          normalizedNumbers,
          buyerName || buyerEmail,
          buyerEmail,
          buyerPhone,
          priceCents,
          finalStatus,
        ]
      );
    } else {
      reservationResult = await client.query(
        `
        INSERT INTO public.promotional_reservations (
          reservation_id,
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
        VALUES (
          $1,
          $2,
          $3,
          $4::int[],
          $5,
          $6,
          $7,
          $8,
          0,
          0,
          'admin',
          $9,
          'approved',
          NULL,
          NOW(),
          NOW()
        )
        RETURNING *
        `,
        [
          reservationId,
          normalizedDrawId,
          normalizedUserId,
          normalizedNumbers,
          buyerName || buyerEmail,
          buyerEmail,
          buyerPhone,
          priceCents,
          finalStatus,
        ]
      );
    }

    const numberUpdate = await client.query(`
      UPDATE public.promotional_numbers
      SET status = $3,
          reservation_id = $4,
          reserved_by = $8,
          buyer_name = $5,
          buyer_email = $6,
          buyer_phone = $7,
          user_id = $9,
          payment_status = 'approved',
          reserved_at = NOW(),
          expires_at = NULL,
          reserved_until = NULL,
          updated_at = NOW()
      WHERE draw_id = $1
        AND COALESCE(
          n::int,
          number_value::int,
          NULLIF(regexp_replace(number::text, '\\D', '', 'g'), '')::integer
        ) = ANY($2::int[])
      RETURNING COALESCE(
        n::int,
        number_value::int,
        NULLIF(regexp_replace(number::text, '\\D', '', 'g'), '')::integer
      ) AS number
    `, [
      normalizedDrawId,
      normalizedNumbers,
      finalStatus,
      reservationId,
      buyerName || buyerEmail,
      buyerEmail,
      buyerPhone,
      String(normalizedUserId),
      normalizedUserId,
    ]);

    if (numberUpdate.rowCount !== normalizedNumbers.length) {
      const err = new Error("Não foi possível atualizar o número promocional atribuído.");
      err.status = 409;
      err.code = "PROMOTIONAL_NUMBER_ALREADY_RESERVED";
      throw err;
    }

    console.log("[PROMOTIONAL_ASSIGNMENT_CREATED]", {
      reservationId: reservationResult.rows[0]?.reservation_id || reservationResult.rows[0]?.id,
      drawId: normalizedDrawId,
      userId: normalizedUserId,
      numbers: normalizedNumbers,
      status: reservationResult.rows[0]?.status,
      paymentStatus: reservationResult.rows[0]?.payment_status,
    });

    await client.query("COMMIT");
    return {
      ok: true,
      reservation_id: reservationResult.rows[0].reservation_id || reservationResult.rows[0].id,
      draw_id: normalizedDrawId,
      numbers: normalizedNumbers,
      status: finalStatus,
      payment_status: "approved",
      source: "admin",
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[promotional.assignNumbers] error:", {
      message: error?.message,
      code: error?.code,
      detail: error?.detail,
      stack: error?.stack,
    });
    throw error;
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
        reservation_id,
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
        payment_id = $4,
        sold_at = COALESCE(sold_at, NOW()),
        updated_at = NOW()
      WHERE draw_id = $1
        AND (reservation_id::text = $2::text OR reservation_id::text = $3::text)
    `, [
      reservation.draw_id,
      reservation.id,
      reservation.reservation_id || reservation.id,
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
      reservation_id: reservation.reservation_id || reservation.id,
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
