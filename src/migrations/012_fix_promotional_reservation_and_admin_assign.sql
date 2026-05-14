CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =========================
-- NORMALIZA TABELA numbers
-- =========================

ALTER TABLE public.numbers
  ADD COLUMN IF NOT EXISTS n INTEGER;

ALTER TABLE public.numbers
  ADD COLUMN IF NOT EXISTS reservation_id TEXT;

ALTER TABLE public.numbers
  ADD COLUMN IF NOT EXISTS user_id TEXT;

ALTER TABLE public.numbers
  ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending';

ALTER TABLE public.numbers
  ADD COLUMN IF NOT EXISTS reserved_until TIMESTAMPTZ;

ALTER TABLE public.numbers
  ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMPTZ;

ALTER TABLE public.numbers
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Se existir coluna number, sincronizar com n
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'numbers'
      AND column_name = 'number'
  ) THEN
    EXECUTE '
      UPDATE public.numbers
      SET n = number::INTEGER
      WHERE n IS NULL
        AND number IS NOT NULL
    ';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_numbers_draw_n
ON public.numbers(draw_id, n)
WHERE draw_id IS NOT NULL AND n IS NOT NULL;


-- ===============================
-- NORMALIZA promotional_numbers
-- ===============================

ALTER TABLE public.promotional_numbers
  ADD COLUMN IF NOT EXISTS number_value INTEGER;

ALTER TABLE public.promotional_numbers
  ADD COLUMN IF NOT EXISTS number TEXT;

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
      USING number::TEXT;
  END IF;
END $$;

ALTER TABLE public.promotional_numbers
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'available';

ALTER TABLE public.promotional_numbers
  ADD COLUMN IF NOT EXISTS reservation_id TEXT;

ALTER TABLE public.promotional_numbers
  ADD COLUMN IF NOT EXISTS reserved_by TEXT;

ALTER TABLE public.promotional_numbers
  ADD COLUMN IF NOT EXISTS buyer_email TEXT;

ALTER TABLE public.promotional_numbers
  ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMPTZ;

ALTER TABLE public.promotional_numbers
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

ALTER TABLE public.promotional_numbers
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

UPDATE public.promotional_numbers
SET number_value = NULLIF(regexp_replace(number::TEXT, '\D', '', 'g'), '')::INTEGER
WHERE number_value IS NULL
  AND number IS NOT NULL
  AND NULLIF(regexp_replace(number::TEXT, '\D', '', 'g'), '') IS NOT NULL;

UPDATE public.promotional_numbers
SET number = LPAD(number_value::TEXT, 2, '0')
WHERE number IS NULL
  AND number_value IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_promotional_numbers_draw_number_value
ON public.promotional_numbers(draw_id, number_value)
WHERE draw_id IS NOT NULL AND number_value IS NOT NULL;


-- =====================================
-- NORMALIZA promotional_reservations
-- =====================================

ALTER TABLE public.promotional_reservations
  ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending';

ALTER TABLE public.promotional_reservations
  ADD COLUMN IF NOT EXISTS amount_cents INTEGER DEFAULT 0;

ALTER TABLE public.promotional_reservations
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

ALTER TABLE public.promotional_reservations
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE public.promotional_reservations
  ADD COLUMN IF NOT EXISTS buyer_name TEXT;

ALTER TABLE public.promotional_reservations
  ADD COLUMN IF NOT EXISTS buyer_email TEXT;

ALTER TABLE public.promotional_reservations
  ADD COLUMN IF NOT EXISTS buyer_phone TEXT;
