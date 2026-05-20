import { getPool } from "../db.js";
import { creditCouponOnApprovedPayment } from "./couponBalance.js";
import { ensureMainRaffleCompat, getTicketPriceCents } from "./mainRaffleCompat.js";

const APPROVED_PAYMENT_STATUSES = new Set(["approved", "paid", "pago"]);

function normalizePaymentStatus(status) {
  return String(status || "").trim().toLowerCase();
}

export function isApprovedPaymentStatus(status) {
  return APPROVED_PAYMENT_STATUSES.has(normalizePaymentStatus(status));
}

export function normalizeNumbersList(value) {
  if (Array.isArray(value)) {
    return value
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 99);
  }

  if (typeof value === "string") {
    return value
      .replace(/[{}[\]\s]/g, "")
      .split(",")
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 99);
  }

  return [];
}

export async function findReservationByAnyId(client, reservationId) {
  const result = await client.query(
    `
    SELECT
      r.id,
      r.reservation_group_id,
      r.user_id,
      r.draw_id,
      r.numbers,
      r.status,
      r.payment_status,
      r.expires_at,
      r.payment_id,
      r.amount_cents,
      r.total_amount_cents
    FROM public.reservations r
    WHERE r.id::text = $1::text
       OR r.reservation_group_id::text = $1::text
    ORDER BY r.created_at DESC NULLS LAST
    LIMIT 1
    `,
    [String(reservationId)]
  );

  return result.rows[0] || null;
}

async function upsertPaymentFromMp(client, paymentId, mpPayment) {
  const mp = mpPayment || {};
  const externalRef = String(mp.external_reference || "").trim();
  const meta = mp.metadata || {};
  const reservationId = String(
    meta.reservation_id || externalRef || ""
  ).trim();

  if (!reservationId) return null;

  const reservation = await findReservationByAnyId(client, reservationId);
  if (!reservation) return null;

  const numbers = normalizeNumbersList(
    meta.numbers || reservation.numbers || []
  );
  const drawId = Number(meta.draw_id || reservation.draw_id || 0);
  const userId = Number(meta.user_id || reservation.user_id || 0);
  const ticketCents = drawId ? await getTicketPriceCents(client, drawId) : 5500;
  const amountCents =
    Number(mp.transaction_amount || 0) > 0
      ? Math.round(Number(mp.transaction_amount) * 100)
      : numbers.length * ticketCents;

  const insertResult = await client.query(
    `
    INSERT INTO public.payments (
      id,
      user_id,
      draw_id,
      numbers,
      amount_cents,
      status,
      provider,
      paid_at
    )
    VALUES ($1, $2, $3, $4::int[], $5, 'approved', 'mercadopago', NOW())
    ON CONFLICT (id) DO UPDATE
       SET status = 'approved',
           user_id = COALESCE(EXCLUDED.user_id, payments.user_id),
           draw_id = COALESCE(EXCLUDED.draw_id, payments.draw_id),
           numbers = CASE
             WHEN cardinality(EXCLUDED.numbers) > 0 THEN EXCLUDED.numbers
             ELSE payments.numbers
           END,
           amount_cents = COALESCE(NULLIF(EXCLUDED.amount_cents, 0), payments.amount_cents),
           provider = 'mercadopago',
           paid_at = COALESCE(payments.paid_at, NOW())
    RETURNING id, user_id, draw_id, numbers, amount_cents, status, coupon_credited
    `,
    [String(paymentId), userId || null, drawId || null, numbers, amountCents]
  );

  return insertResult.rows[0] || null;
}

/**
 * Liquida pagamento PIX aprovado do sorteio principal (idempotente).
 */
export async function settleApprovedMainPayment(paymentId, options = {}) {
  const cleanPaymentId = String(paymentId || "").trim();
  if (!cleanPaymentId) {
    return {
      ok: false,
      reason: "missing_payment_id",
      paymentId: null,
      drawId: null,
      userId: null,
      numbers: [],
      creditResult: null,
    };
  }

  const pool = await getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await ensureMainRaffleCompat(client);

    let paymentRes = await client.query(
      `
      SELECT
        id,
        user_id,
        draw_id,
        numbers,
        amount_cents,
        status,
        coupon_credited,
        paid_at
      FROM public.payments
      WHERE id = $1::text
      LIMIT 1
      FOR UPDATE
      `,
      [cleanPaymentId]
    );

    let payment = paymentRes.rows[0] || null;

    if (!payment && options.mpPayment) {
      payment = await upsertPaymentFromMp(client, cleanPaymentId, options.mpPayment);
      if (payment) {
        paymentRes = { rows: [payment] };
      }
    }

    if (!payment) {
      await client.query("ROLLBACK");
      console.warn("[MAIN_PAYMENT_SETTLED_SKIP]", {
        paymentId: cleanPaymentId,
        reason: "payment_not_found",
        source: options.source || null,
      });
      return {
        ok: false,
        reason: "payment_not_found",
        paymentId: cleanPaymentId,
        drawId: null,
        userId: null,
        numbers: [],
        creditResult: null,
      };
    }

    const drawId = Number(payment.draw_id || 0);
    const userId = Number(payment.user_id || 0);
    const numbers = normalizeNumbersList(payment.numbers);

    if (!drawId || !numbers.length) {
      await client.query("ROLLBACK");
      console.warn("[MAIN_PAYMENT_SETTLED_SKIP]", {
        paymentId: cleanPaymentId,
        reason: "missing_draw_or_numbers",
        drawId,
        numbers,
      });
      return {
        ok: false,
        reason: "missing_draw_or_numbers",
        paymentId: cleanPaymentId,
        drawId,
        userId,
        numbers,
        creditResult: null,
      };
    }

    await client.query(
      `
      UPDATE public.payments
         SET status = 'approved',
             paid_at = COALESCE(paid_at, NOW()),
             provider = 'mercadopago'
       WHERE id = $1::text
      `,
      [cleanPaymentId]
    );

    await client.query(
      `
      UPDATE public.numbers
         SET status = 'sold',
             payment_status = 'paid',
             payment_id = $1::text,
             reserved_until = NULL,
             reservation_id = NULL,
             updated_at = NOW()
       WHERE draw_id = $2
         AND COALESCE(n::int, number) = ANY($3::int[])
         AND LOWER(COALESCE(payment_status, 'pending')) NOT IN ('paid', 'approved', 'pago')
      `,
      [cleanPaymentId, drawId, numbers]
    );

    await client.query(
      `
      UPDATE public.reservations
         SET status = 'paid',
             payment_status = 'paid',
             payment_id = $1::text,
             updated_at = NOW()
       WHERE payment_id = $1::text
          OR (
            draw_id = $2
            AND user_id = $3
            AND numbers && $4::int[]
          )
      `,
      [cleanPaymentId, drawId, userId || null, numbers]
    );

    const creditResult = await creditCouponOnApprovedPayment(cleanPaymentId, {
      channel: "PIX",
      source: options.source || "main_payment_settlement",
      runTraceId: options.runTraceId || null,
      pgClient: client,
      meta: {
        draw_id: drawId,
        numbers,
        amount_cents: payment.amount_cents,
        cashback_source: "draws.cashback_percent",
        ...(options.meta && typeof options.meta === "object" ? options.meta : {}),
      },
    });

    await client.query("COMMIT");

    console.log("[MAIN_PAYMENT_SETTLED]", {
      paymentId: cleanPaymentId,
      drawId,
      numbers,
      action: creditResult?.action,
      delta_cents: creditResult?.delta_cents,
      source: options.source || null,
    });

    return {
      ok: true,
      paymentId: cleanPaymentId,
      drawId,
      userId,
      numbers,
      creditResult,
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }

    console.error("[MAIN_PAYMENT_SETTLED_ERROR]", {
      paymentId: cleanPaymentId,
      message: err?.message,
      code: err?.code,
      source: options.source || null,
    });

    throw err;
  } finally {
    client.release();
  }
}
