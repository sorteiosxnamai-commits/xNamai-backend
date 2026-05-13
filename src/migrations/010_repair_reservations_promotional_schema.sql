-- Migration 010: repair normal/promotional reservation + PIX schema
-- Idempotente e compatível com schemas antigos do xNaMai/NewStore.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Sorteios promocionais
CREATE TABLE IF NOT EXISTS public.promotional_draws (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '',
  prize TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  price_cents INTEGER NOT NULL DEFAULT 0,
  number_start INTEGER DEFAULT 0,
  number_end INTEGER DEFAULT 99,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  archived_at TIMESTAMPTZ NULL
);

ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';
ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS prize TEXT DEFAULT '';
ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS price_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS number_start INTEGER DEFAULT 0;
ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS number_end INTEGER DEFAULT 99;
ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE public.promotional_draws ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NULL;

-- Reservas promocionais
CREATE TABLE IF NOT EXISTS public.promotional_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draw_id BIGINT NOT NULL,
  user_id INTEGER NULL,
  buyer_email TEXT NULL,
  buyer_name TEXT NULL,
  buyer_phone TEXT NULL,
  numbers INTEGER[] NOT NULL DEFAULT '{}',
  price_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'reserved',
  payment_status TEXT NOT NULL DEFAULT 'pending',
  payment_provider TEXT NULL,
  payment_id TEXT NULL,
  pix_qr_code TEXT NULL,
  pix_qr_code_base64 TEXT NULL,
  pix_copy_paste TEXT NULL,
  pix_ticket_url TEXT NULL,
  paid_at TIMESTAMPTZ NULL,
  source TEXT DEFAULT 'public',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS user_id INTEGER NULL;
ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS buyer_email TEXT NULL;
ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS buyer_name TEXT NULL;
ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS buyer_phone TEXT NULL;
ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS numbers INTEGER[] NOT NULL DEFAULT '{}';
ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS price_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS total_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS amount_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'reserved';
ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS payment_provider TEXT NULL;
ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS payment_id TEXT NULL;
ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS pix_qr_code TEXT NULL;
ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS pix_qr_code_base64 TEXT NULL;
ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS pix_copy_paste TEXT NULL;
ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS pix_ticket_url TEXT NULL;
ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ NULL;
ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'public';
ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE public.promotional_reservations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Números promocionais: suporta tanto number_value quanto n.
CREATE TABLE IF NOT EXISTS public.promotional_numbers (
  id BIGSERIAL PRIMARY KEY,
  draw_id BIGINT NOT NULL,
  n INTEGER NULL,
  number_value INTEGER NULL,
  label TEXT NULL,
  status TEXT DEFAULT 'available',
  reservation_id UUID NULL,
  user_id INTEGER NULL,
  buyer_email TEXT NULL,
  buyer_name TEXT NULL,
  buyer_phone TEXT NULL,
  payment_status TEXT DEFAULT 'pending',
  payment_id TEXT NULL,
  reserved_at TIMESTAMPTZ NULL,
  sold_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS n INTEGER NULL;
ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS number_value INTEGER NULL;
ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS label TEXT NULL;
ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'available';
ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS user_id INTEGER NULL;
ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS buyer_email TEXT NULL;
ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS buyer_name TEXT NULL;
ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS buyer_phone TEXT NULL;
ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending';
ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS payment_id TEXT NULL;
ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMPTZ NULL;
ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS sold_at TIMESTAMPTZ NULL;
ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE public.promotional_numbers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

DO $$
DECLARE
  reservation_type text;
BEGIN
  SELECT udt_name INTO reservation_type
    FROM information_schema.columns
   WHERE table_schema='public'
     AND table_name='promotional_numbers'
     AND column_name='reservation_id';

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

UPDATE public.promotional_numbers
   SET n = number_value
 WHERE n IS NULL AND number_value IS NOT NULL;

UPDATE public.promotional_numbers
   SET number_value = n
 WHERE number_value IS NULL AND n IS NOT NULL;

UPDATE public.promotional_numbers
   SET label = COALESCE(label, number_value::text, n::text)
 WHERE label IS NULL;

-- Reservas normais
ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending';
ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS amount_cents INTEGER;
ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS payment_id TEXT NULL;
ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS pix_qr_code TEXT NULL;
ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS pix_qr_code_base64 TEXT NULL;
ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS pix_copy_paste TEXT NULL;
ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Usuários: garante timestamps básicos sem assumir colunas sensíveis.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS promotional_numbers_draw_n_idx
  ON public.promotional_numbers(draw_id, n)
  WHERE n IS NOT NULL;

CREATE INDEX IF NOT EXISTS promotional_numbers_draw_number_value_idx
  ON public.promotional_numbers(draw_id, number_value);

CREATE INDEX IF NOT EXISTS promotional_reservations_user_idx
  ON public.promotional_reservations(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS reservations_user_idx
  ON public.reservations(user_id, created_at DESC);
