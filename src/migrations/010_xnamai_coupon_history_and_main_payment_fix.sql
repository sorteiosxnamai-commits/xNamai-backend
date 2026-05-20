-- Migration 010: coupon_balance_history + colunas de liquidação PIX / cashback
-- Idempotente — seguro em bases que já rodaram migrações anteriores

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- Ledger de cashback (tabela ausente no schema real)
-- ============================================================================

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
);

ALTER TABLE public.coupon_balance_history
  ADD COLUMN IF NOT EXISTS gross_amount_cents int4 NULL;

ALTER TABLE public.coupon_balance_history
  ADD COLUMN IF NOT EXISTS cashback_percent int4 NULL;

ALTER TABLE public.coupon_balance_history
  ADD COLUMN IF NOT EXISTS cashback_amount_cents int4 NULL;

CREATE INDEX IF NOT EXISTS idx_coupon_hist_user_created
  ON public.coupon_balance_history (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_coupon_hist_payment
  ON public.coupon_balance_history (payment_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_coupon_hist_payment_credit_purchase
  ON public.coupon_balance_history (payment_id, event_type)
  WHERE payment_id IS NOT NULL AND event_type = 'CREDIT_PURCHASE';

-- ============================================================================
-- payments / draws / reservations / numbers
-- ============================================================================

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS coupon_credited boolean NOT NULL DEFAULT false;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS coupon_credited_at timestamptz NULL;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS coupon_cashback_percent int4 NULL;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS coupon_amount_cents int4 NULL;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS provider text DEFAULT 'mercadopago';

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS provider_payment_id text NULL;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS external_reference text NULL;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS pix_qr_code text NULL;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS pix_qr_code_base64 text NULL;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS pix_ticket_url text NULL;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS pix_copy_paste text NULL;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS raw jsonb NULL;

ALTER TABLE public.draws
  ADD COLUMN IF NOT EXISTS cashback_percent integer NOT NULL DEFAULT 100;

ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS paid_at timestamptz NULL;

ALTER TABLE public.numbers
  ADD COLUMN IF NOT EXISTS sold_at timestamptz NULL;

-- Backfill: reservas públicas antigas sem expires_at
UPDATE public.reservations
   SET expires_at = created_at + interval '30 minutes'
 WHERE expires_at IS NULL
   AND LOWER(COALESCE(source, 'public')) IN ('public', '')
   AND LOWER(COALESCE(payment_status, 'pending')) NOT IN ('paid', 'approved', 'pago')
   AND LOWER(COALESCE(status, '')) IN ('active', 'pending', 'reserved', 'reservado', 'pendente');

UPDATE public.numbers n
   SET reserved_until = r.expires_at
  FROM public.reservations r
 WHERE n.reserved_until IS NULL
   AND n.reservation_id IS NOT NULL
   AND (
     n.reservation_id::text = r.id::text
     OR n.reservation_id::text = r.reservation_group_id::text
   )
   AND r.expires_at IS NOT NULL
   AND LOWER(COALESCE(n.payment_status, 'pending')) NOT IN ('paid', 'approved', 'pago')
   AND LOWER(COALESCE(n.status, '')) IN ('reserved', 'pending', 'reservado', 'pendente');
