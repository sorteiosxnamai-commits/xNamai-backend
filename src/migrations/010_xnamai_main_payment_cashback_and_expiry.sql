-- Migration 010: cashback principal, colunas de liquidação PIX e expiração de reservas
-- Idempotente / compatível com bases existentes

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- draws: percentual de cashback por número pago
ALTER TABLE public.draws
  ADD COLUMN IF NOT EXISTS cashback_percent INTEGER NOT NULL DEFAULT 100;

-- payments: provider e flags de cashback
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'mercadopago',
  ADD COLUMN IF NOT EXISTS coupon_credited BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS coupon_credited_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS coupon_cashback_percent INTEGER NULL,
  ADD COLUMN IF NOT EXISTS coupon_amount_cents INTEGER NULL;

-- coupon_balance_history: detalhamento do cashback
ALTER TABLE public.coupon_balance_history
  ADD COLUMN IF NOT EXISTS gross_amount_cents INTEGER NULL,
  ADD COLUMN IF NOT EXISTS cashback_percent INTEGER NULL,
  ADD COLUMN IF NOT EXISTS cashback_amount_cents INTEGER NULL;

-- reservations: grupo, PIX e expiração
ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS reservation_group_id UUID DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS payment_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS amount_cents INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_amount_cents INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pix_qr_code TEXT NULL,
  ADD COLUMN IF NOT EXISTS pix_qr_code_base64 TEXT NULL,
  ADD COLUMN IF NOT EXISTS pix_copy_paste TEXT NULL,
  ADD COLUMN IF NOT EXISTS pix_ticket_url TEXT NULL,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- numbers: aliases e campos de reserva/pagamento
ALTER TABLE public.numbers
  ADD COLUMN IF NOT EXISTS number INTEGER NULL,
  ADD COLUMN IF NOT EXISTS user_id BIGINT NULL,
  ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS payment_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS reserved_until TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Sincroniza n <-> number
UPDATE public.numbers
   SET number = n::int
 WHERE number IS NULL
   AND n IS NOT NULL;

UPDATE public.numbers
   SET n = number::smallint
 WHERE n IS NULL
   AND number IS NOT NULL;

-- Índices de performance
CREATE INDEX IF NOT EXISTS idx_payments_status ON public.payments (status);
CREATE INDEX IF NOT EXISTS idx_payments_user_id ON public.payments (user_id);
CREATE INDEX IF NOT EXISTS idx_payments_draw_id ON public.payments (draw_id);
CREATE INDEX IF NOT EXISTS idx_reservations_user_id ON public.reservations (user_id);
CREATE INDEX IF NOT EXISTS idx_reservations_payment_id ON public.reservations (payment_id);
CREATE INDEX IF NOT EXISTS idx_reservations_reservation_group_id ON public.reservations (reservation_group_id);
CREATE INDEX IF NOT EXISTS idx_numbers_draw_id_status ON public.numbers (draw_id, status);
CREATE INDEX IF NOT EXISTS idx_numbers_draw_id_payment_status ON public.numbers (draw_id, payment_status);
