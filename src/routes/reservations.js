// backend/src/routes/reservations.js
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { query, getPool } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import {
  ensureMainRaffleCompat,
  reservationIdIsUuid,
} from '../services/mainRaffleCompat.js';
import {
  cleanupExpiredMainReservations,
  ensureMainNumbersExist,
} from '../services/mainReservationExpiry.js';
import { getTicketPriceCents } from '../services/mainRaffleCompat.js';
import { mpCreatePixPayment } from '../services/mercadopago.js';
import {
  isApprovedPaymentStatus,
  settleApprovedMainPayment,
} from '../services/mainPaymentSettlement.js';
import { getBackendPublicUrl } from '../utils/backendUrl.js';

const router = Router();
const RESERVATION_TTL_MINUTES = 30;

/**
 * Expira reservas vencidas (best-effort, fora da transação principal).
 * Mantido para “limpeza geral”; a expiração crítica também acontece
 * dentro da transação ao reservar (garante consistência).
 */
async function cleanupExpiredGlobal(client = null) {
  await cleanupExpiredMainReservations(client);
}

router.post('/', requireAuth, async (req, res) => {
  const pool = await getPool();
  const client = await pool.connect();
  let txStarted = false;

  try {
    const { numbers } = req.body || {};
    if (!Array.isArray(numbers) || numbers.length === 0) {
      return res.status(400).json({ ok: false, error: 'no_numbers' });
    }

    const nums = Array.from(
      new Set(
        numbers
          .map(Number)
          .filter((n) => Number.isInteger(n) && n >= 0 && n <= 99)
      )
    );

    if (!nums.length) {
      return res.status(400).json({ ok: false, error: 'numbers_invalid' });
    }

    await cleanupExpiredGlobal(client);

    const requestedDrawId = Number(
      req.body?.draw_id ??
      req.body?.drawId ??
      req.query?.draw_id ??
      req.query?.drawId ??
      0
    );

    let drawResult;

    if (Number.isInteger(requestedDrawId) && requestedDrawId > 0) {
      drawResult = await client.query(
        `
        SELECT id
          FROM public.draws
         WHERE id = $1
           AND LOWER(COALESCE(status, 'open')) IN ('open', 'active', 'ativo')
         LIMIT 1
        `,
        [requestedDrawId]
      );
    } else {
      drawResult = await client.query(
        `
        SELECT id
          FROM public.draws
         WHERE LOWER(COALESCE(status, 'open')) IN ('open', 'active', 'ativo')
      ORDER BY id DESC
         LIMIT 1
        `
      );
    }

    if (!drawResult.rows.length) {
      return res.status(400).json({
        ok: false,
        error: 'no_open_draw',
        message: 'Nenhum sorteio principal aberto encontrado para reserva.',
        draw_id: requestedDrawId || null,
      });
    }

    const drawId = Number(drawResult.rows[0].id);
    const expiresAt = new Date(Date.now() + RESERVATION_TTL_MINUTES * 60 * 1000);

    await client.query('BEGIN');
    txStarted = true;

    await ensureMainRaffleCompat(client);
    await cleanupExpiredMainReservations(client, drawId);
    await ensureMainNumbersExist(client, drawId, nums);

    const priceRow = await client.query(
      `
      SELECT COALESCE(ticket_price_cents, price_cents, 5500)::int AS price_cents
        FROM public.draws
       WHERE id = $1
       LIMIT 1
      `,
      [drawId]
    );
    const priceCents = Number(priceRow.rows?.[0]?.price_cents || 5500);
    const amountCents = nums.length * priceCents;
    const groupId = randomUUID();
    const usesUuidId = await reservationIdIsUuid(client);

    const locked = await client.query(
      `SELECT COALESCE(n::int, number) AS number, status, reservation_id, reserved_until, payment_status
         FROM public.numbers
        WHERE draw_id = $1
          AND COALESCE(n::int, number) = ANY($2::int[])
        FOR UPDATE`,
      [drawId, nums]
    );

    const conflicts = locked.rows
      .filter((row) => {
        const status = String(row.status || 'available').toLowerCase();
        const paymentStatus = String(row.payment_status || 'pending').toLowerCase();

        if (['sold', 'paid', 'approved', 'pago', 'vendido', 'aprovado', 'blocked', 'bloqueado'].includes(status)) {
          return true;
        }

        if (['paid', 'approved', 'pago'].includes(paymentStatus)) {
          return true;
        }

        if (['reserved', 'pending', 'reservado', 'pendente'].includes(status)) {
          return !row.reserved_until || new Date(row.reserved_until).getTime() > Date.now();
        }

        return false;
      })
      .map((row) => Number(row.number));

    if (conflicts.length) {
      await client.query('ROLLBACK');
      txStarted = false;
      return res.status(409).json({ ok: false, error: 'unavailable', conflicts });
    }

    let reservationIdForResponse = groupId;

    if (usesUuidId) {
      await client.query(
        `INSERT INTO public.reservations (
          id,
          reservation_group_id,
          user_id,
          draw_id,
          numbers,
          quantity,
          total_amount_cents,
          total_cents,
          amount_cents,
          status,
          payment_status,
          buyer_name,
          buyer_email,
          expires_at,
          source,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          $1,
          $2,
          $3,
          $4::int[],
          CARDINALITY($4::int[]),
          $5,
          $5,
          $5,
          'reserved',
          'pending',
          $6,
          $7,
          $8,
          'public',
          NOW(),
          NOW()
        )`,
        [
          groupId,
          req.user.id,
          drawId,
          nums,
          amountCents,
          req.user?.name || req.user?.nome || req.user?.email || null,
          req.user?.email || null,
          expiresAt,
        ]
      );

      const reservationIdForNumbers = groupId;

      const updateNumbersResult = await client.query(
        `
        UPDATE public.numbers
           SET status = 'reserved',
               reservation_id = $3,
               user_id = $4,
               payment_status = 'pending',
               payment_id = NULL,
               reserved_at = NOW(),
               reserved_until = $5,
               updated_at = NOW()
         WHERE draw_id = $1
           AND COALESCE(n::int, number) = ANY($2::int[])
           AND (
             LOWER(COALESCE(status, 'available')) IN ('available', '')
             OR (
               LOWER(COALESCE(status, '')) IN ('reserved', 'pending', 'reservado', 'pendente')
               AND reserved_until IS NOT NULL
               AND reserved_until <= NOW()
             )
           )
           AND LOWER(COALESCE(payment_status, 'pending')) NOT IN ('paid', 'approved', 'pago')
        `,
        [drawId, nums, reservationIdForNumbers, req.user.id, expiresAt]
      );

      if (Number(updateNumbersResult.rowCount || 0) !== nums.length) {
        throw new Error(
          `main_numbers_not_reserved:${updateNumbersResult.rowCount}/${nums.length}`
        );
      }
    } else {
      const inserted = await client.query(
        `INSERT INTO public.reservations (
          reservation_group_id,
          user_id,
          draw_id,
          numbers,
          quantity,
          price_cents,
          total_amount_cents,
          total_cents,
          amount_cents,
          status,
          payment_status,
          buyer_name,
          buyer_email,
          expires_at,
          source,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4::int[],
          CARDINALITY($4::int[]),
          $5,
          $6,
          $6,
          $6,
          'reserved',
          'pending',
          $7,
          $8,
          $9,
          'public',
          NOW(),
          NOW()
        )
        RETURNING id`,
        [
          groupId,
          req.user.id,
          drawId,
          nums,
          priceCents,
          amountCents,
          req.user?.name || req.user?.nome || req.user?.email || null,
          req.user?.email || null,
          expiresAt,
        ]
      );

      const reservationRowId = inserted.rows[0]?.id;
      reservationIdForResponse = groupId;
      const reservationIdForNumbers = String(reservationRowId);

      const updateNumbersResult = await client.query(
        `
        UPDATE public.numbers
           SET status = 'reserved',
               reservation_id = $3,
               user_id = $4,
               payment_status = 'pending',
               payment_id = NULL,
               reserved_at = NOW(),
               reserved_until = $5,
               updated_at = NOW()
         WHERE draw_id = $1
           AND COALESCE(n::int, number) = ANY($2::int[])
           AND (
             LOWER(COALESCE(status, 'available')) IN ('available', '')
             OR (
               LOWER(COALESCE(status, '')) IN ('reserved', 'pending', 'reservado', 'pendente')
               AND reserved_until IS NOT NULL
               AND reserved_until <= NOW()
             )
           )
           AND LOWER(COALESCE(payment_status, 'pending')) NOT IN ('paid', 'approved', 'pago')
        `,
        [drawId, nums, reservationIdForNumbers, req.user.id, expiresAt]
      );

      if (Number(updateNumbersResult.rowCount || 0) !== nums.length) {
        throw new Error(
          `main_numbers_not_reserved:${updateNumbersResult.rowCount}/${nums.length}`
        );
      }
    }

    await client.query('COMMIT');
    txStarted = false;

    return res.status(201).json({
      ok: true,
      success: true,
      reservationId: reservationIdForResponse,
      reservation_id: reservationIdForResponse,
      id: reservationIdForResponse,
      drawId,
      draw_id: drawId,
      expiresAt,
      expires_at: expiresAt,
      numbers: nums,
      amount_cents: amountCents,
      payment_status: 'pending',
      status: 'reserved',
      can_pay: true,
      canPay: true,
    });
  } catch (err) {
    if (txStarted) {
      try {
        await client.query('ROLLBACK');
      } catch {}
    }

    console.error('[MAIN_RESERVATION_CREATE_ERROR]', {
      code: err?.code,
      message: err?.message,
      detail: err?.detail,
      hint: err?.hint,
      stack: err?.stack,
      body: req.body,
      user: req.user?.id,
    });

    return res.status(500).json({
      ok: false,
      error: 'reserve_failed',
      message: err?.message || 'Falha ao reservar números.',
      code: err?.code || 'RESERVATION_CREATE_ERROR',
      detail: err?.detail || null,
      hint: err?.hint || null,
    });
  } finally {
    client.release();
  }
});

router.post('/:reservationId/pix', requireAuth, async (req, res) => {
  try {
    const reservationId = req.params.reservationId;
    const r = await query(
      `SELECT r.id,
              r.reservation_group_id,
              r.user_id,
              r.draw_id,
              r.numbers,
              r.status,
              r.payment_status,
              r.expires_at,
              r.created_at,
              u.email AS user_email,
              u.name AS user_name
         FROM public.reservations r
    LEFT JOIN public.users u ON u.id = r.user_id
        WHERE r.id::text = $1::text
           OR r.reservation_group_id::text = $1::text
        LIMIT 1`,
      [reservationId]
    );

    if (!r.rows.length) {
      return res.status(404).json({ ok: false, error: 'Reserva não encontrada.' });
    }

    const reservation = r.rows[0];
    if (Number(reservation.user_id) !== Number(req.user.id)) {
      return res.status(403).json({
        ok: false,
        error: 'Você não tem permissão para pagar esta reserva.',
      });
    }

    const paymentStatus = String(reservation.payment_status || 'pending').toLowerCase();
    if (paymentStatus !== 'pending') {
      return res.status(400).json({
        ok: false,
        error: 'Esta reserva não está pendente de pagamento.',
      });
    }

    const reservationStatus = String(reservation.status || '').toLowerCase();
    if (['cancelled', 'expired'].includes(reservationStatus)) {
      return res.status(400).json({
        ok: false,
        error: 'Esta reserva não pode ser paga.',
      });
    }

    const effectiveExpires = reservation.expires_at
      ? new Date(reservation.expires_at)
      : reservation.created_at
        ? new Date(new Date(reservation.created_at).getTime() + RESERVATION_TTL_MINUTES * 60 * 1000)
        : null;
    if (effectiveExpires && effectiveExpires.getTime() < Date.now()) {
      return res.status(400).json({
        ok: false,
        error: 'Reserva expirada.',
      });
    }

    const priceCents = await getTicketPriceCents(null, reservation.draw_id);
    const numbers = Array.isArray(reservation.numbers) ? reservation.numbers.map(Number) : [];
    const amountCents = numbers.length * priceCents;

    const pix = await mpCreatePixPayment({
      amount_cents: amountCents,
      description: `Sorteio xNaMai - números ${numbers.map((n) => String(n).padStart(2, '0')).join(', ')}`,
      payer_email: reservation.user_email || req.user.email,
      payer_name: reservation.user_name || req.user.name || req.user.email,
      external_reference: String(reservationId),
      notification_url: (() => {
        const url = `${getBackendPublicUrl(req)}/api/payments/webhook`;
        console.log('[MP_NOTIFICATION_URL]', { notificationUrl: url });
        return url;
      })(),
      metadata: {
        type: 'main',
        draw_id: reservation.draw_id,
        reservation_id: reservationId,
        numbers,
        user_id: req.user.id,
      },
      idempotency_key: `main-${reservationId}-${Date.now()}`,
    });

    await query(
      `INSERT INTO payments (
         id, user_id, draw_id, numbers, amount_cents, status,
         provider, provider_payment_id, external_reference,
         qr_code, qr_code_base64, pix_qr_code, pix_qr_code_base64,
         pix_ticket_url, pix_copy_paste, updated_at
       )
       VALUES (
         $1,$2,$3,$4,$5,$6,'mercadopago',$1,$7,
         $8,$9,$8,$9,$10,$8,NOW()
       )
       ON CONFLICT (id) DO UPDATE
         SET status = EXCLUDED.status,
             provider = 'mercadopago',
             provider_payment_id = COALESCE(EXCLUDED.provider_payment_id, payments.provider_payment_id),
             external_reference = COALESCE(EXCLUDED.external_reference, payments.external_reference),
             qr_code = COALESCE(EXCLUDED.qr_code, payments.qr_code),
             qr_code_base64 = COALESCE(EXCLUDED.qr_code_base64, payments.qr_code_base64),
             pix_qr_code = COALESCE(EXCLUDED.pix_qr_code, payments.pix_qr_code),
             pix_qr_code_base64 = COALESCE(EXCLUDED.pix_qr_code_base64, payments.pix_qr_code_base64),
             pix_ticket_url = COALESCE(EXCLUDED.pix_ticket_url, payments.pix_ticket_url),
             pix_copy_paste = COALESCE(EXCLUDED.pix_copy_paste, payments.pix_copy_paste),
             updated_at = NOW()`,
      [
        pix.payment_id,
        req.user.id,
        reservation.draw_id,
        numbers,
        amountCents,
        pix.status,
        String(reservationId),
        pix.qr_code || null,
        pix.qr_code_base64 || null,
        pix.ticket_url || null,
      ]
    );

    const pixPaid = isApprovedPaymentStatus(pix.status);

    await query(
      `UPDATE reservations
          SET payment_id = $2,
              payment_status = $3,
              amount_cents = COALESCE(amount_cents, $4),
              total_amount_cents = COALESCE(total_amount_cents, $4),
              pix_qr_code = $5,
              pix_qr_code_base64 = $6,
              pix_copy_paste = $5,
              pix_ticket_url = $7,
              updated_at = NOW()
        WHERE id::text = $1::text
           OR reservation_group_id::text = $1::text`,
      [
        reservationId,
        pix.payment_id,
        pixPaid ? 'paid' : 'pending',
        amountCents,
        pix.qr_code || null,
        pix.qr_code_base64 || null,
        pix.ticket_url || null,
      ]
    );

    console.log('[MP_PIX_CREATED]', {
      paymentId: pix.payment_id,
      reservationId,
      drawId: reservation.draw_id,
      numbers,
      status: pix.status,
    });

    if (pixPaid) {
      await settleApprovedMainPayment(String(pix.payment_id), {
        source: 'reservations_pix_immediate_approved',
      });
    }

    return res.json({
      ok: true,
      payment_id: pix.payment_id,
      reservation_id: reservationId,
      qr_code: pix.qr_code,
      qr_code_base64: pix.qr_code_base64,
      copy_paste: pix.qr_code,
      ticket_url: pix.ticket_url,
      amount: pix.amount,
      payment_status: 'pending',
    });
  } catch (err) {
    console.error('[MAIN_PIX_ERROR]', {
      code: err?.code,
      message: err?.message,
      detail: err?.detail,
      hint: err?.hint,
      stack: err?.stack,
    });

    return res.status(500).json({
      ok: false,
      error: 'Erro ao gerar PIX da reserva.',
      code: err?.code || 'MAIN_PIX_ERROR',
    });
  }
});

export default router;
