// backend/src/routes/numbers.js
import { Router } from 'express';
import { query } from '../db.js';
import { ensureMainRaffleCompat } from '../services/mainRaffleCompat.js';
import { cleanupExpiredMainReservations } from '../services/mainReservationExpiry.js';

const router = Router();

function initialsFromNameOrEmail(name, email) {
  const nm = String(name || '').trim();
  if (nm) {
    const parts = nm.split(/\s+/).filter(Boolean);
    const first = parts[0]?.[0] || '';
    const last = parts.length > 1 ? parts[parts.length - 1][0] : parts[0]?.[1] || '';
    return (first + last).toUpperCase();
  }

  const mail = String(email || '').trim();
  const user = mail.includes('@') ? mail.split('@')[0] : mail;
  return user.slice(0, 2).toUpperCase();
}

/**
 * GET /api/numbers
 *
 * Regras do Sorteio Principal:
 * - status sold/paid/approved => indisponível.
 * - status reserved/pending com reserved_until > NOW() => reservado por 30 minutos.
 * - status reserved/pending com reserved_until NULL e user_id preenchido => reservado permanente pelo admin.
 * - reserved_until vencido => volta para available pela limpeza.
 *
 * Aceita draw_id opcional:
 *   /api/numbers?draw_id=10
 *
 * Se não vier draw_id, usa o sorteio aberto mais recente, preservando compatibilidade.
 */
router.get('/', async (req, res) => {
  try {
    await ensureMainRaffleCompat();

    const requestedDrawId = Number(req.query.draw_id || req.query.drawId || 0);

    let drawId = null;

    if (Number.isInteger(requestedDrawId) && requestedDrawId > 0) {
      const dr = await query(
        `SELECT id FROM public.draws WHERE id = $1 LIMIT 1`,
        [requestedDrawId]
      );

      if (!dr.rows.length) {
        return res.status(404).json({
          ok: false,
          error: 'draw_not_found',
          drawId: requestedDrawId,
          numbers: [],
        });
      }

      drawId = Number(dr.rows[0].id);
    } else {
      const dr = await query(
        `SELECT id FROM public.draws WHERE status = 'open' ORDER BY id DESC LIMIT 1`
      );

      if (!dr.rows.length) {
        return res.json({
          ok: true,
          drawId: null,
          draw_id: null,
          numbers: [],
        });
      }

      drawId = Number(dr.rows[0].id);
    }

    await cleanupExpiredMainReservations(null, drawId);

    const expiredReservationLinks = await query(
      `
      SELECT id::text AS id, reservation_group_id::text AS group_id
        FROM public.reservations
       WHERE draw_id = $1
         AND expires_at IS NOT NULL
         AND expires_at <= NOW()
         AND LOWER(COALESCE(status, '')) IN ('expired', 'cancelled', 'canceled')
      `,
      [drawId]
    );

    const expiredLinkIds = new Set();
    for (const row of expiredReservationLinks.rows || []) {
      if (row.id) expiredLinkIds.add(String(row.id));
      if (row.group_id) expiredLinkIds.add(String(row.group_id));
    }

    const pays = await query(
      `
      SELECT
        num.n::int AS n,
        u.name AS owner_name,
        u.email AS owner_email
      FROM public.payments p
      LEFT JOIN public.users u ON u.id = p.user_id
      CROSS JOIN LATERAL UNNEST(COALESCE(p.numbers, '{}'::int[])) AS num(n)
      WHERE p.draw_id = $1
        AND LOWER(COALESCE(p.status, '')) IN ('approved', 'paid', 'pago')
      `,
      [drawId]
    );

    const initialsByN = new Map();

    for (const row of pays.rows || []) {
      const num = Number(row.n);
      if (!Number.isInteger(num)) continue;

      const ini = initialsFromNameOrEmail(row.owner_name, row.owner_email);
      initialsByN.set(num, ini);
    }

    const base = await query(
      `
      SELECT
        COALESCE(n::int, number) AS n,
        status,
        payment_status,
        reserved_until,
        reserved_at,
        user_id,
        reservation_id
      FROM public.numbers
      WHERE draw_id = $1
      ORDER BY COALESCE(n::int, number) ASC
      `,
      [drawId]
    );

    const now = Date.now();

    const numbers = base.rows
      .map((row) => {
        const num = Number(row.n);
        if (!Number.isInteger(num)) return null;

        const status = String(row.status || 'available').toLowerCase();
        const paymentStatus = String(row.payment_status || 'pending').toLowerCase();

        const reservedUntilMs = row.reserved_until
          ? new Date(row.reserved_until).getTime()
          : null;

        const isPaid =
          ['sold', 'paid', 'approved', 'pago', 'vendido', 'aprovado'].includes(status) ||
          ['paid', 'approved', 'pago'].includes(paymentStatus) ||
          initialsByN.has(num);

        if (isPaid) {
          return {
            n: num,
            number: num,
            label: String(num).padStart(2, '0'),
            status: 'sold',
            payment_status: 'paid',
            owner_initials: initialsByN.get(num) || null,
            reserved_until: row.reserved_until || null,
          };
        }

        const isReservedStatus = ['reserved', 'pending', 'reservado', 'pendente'].includes(status);

        const isTemporaryReservation =
          isReservedStatus &&
          reservedUntilMs &&
          reservedUntilMs > now;

        const reservationLink = row.reservation_id
          ? String(row.reservation_id)
          : null;

        const linkedToExpiredReservation =
          reservationLink && expiredLinkIds.has(reservationLink);

        const isAdminPermanentReservation =
          isReservedStatus &&
          !reservedUntilMs &&
          row.user_id != null &&
          !linkedToExpiredReservation &&
          paymentStatus === 'pending';

        if (isTemporaryReservation || isAdminPermanentReservation) {
          return {
            n: num,
            number: num,
            label: String(num).padStart(2, '0'),
            status: 'reserved',
            payment_status: paymentStatus || 'pending',
            reserved_until: row.reserved_until || null,
            permanent: Boolean(isAdminPermanentReservation),
          };
        }

        return {
          n: num,
          number: num,
          label: String(num).padStart(2, '0'),
          status: 'available',
          payment_status: paymentStatus || 'pending',
          reserved_until: null,
        };
      })
      .filter(Boolean);

    return res.json({
      ok: true,
      drawId,
      draw_id: drawId,
      numbers,
    });
  } catch (err) {
    console.error('[MAIN_NUMBERS_LIST_ERROR]', {
      code: err?.code,
      message: err?.message,
      detail: err?.detail,
      hint: err?.hint,
      stack: err?.stack,
    });

    return res.status(500).json({
      ok: false,
      error: 'failed_to_list_numbers',
      message: err?.message || 'Falha ao listar números.',
      code: err?.code || 'MAIN_NUMBERS_LIST_ERROR',
      detail: err?.detail || null,
      hint: err?.hint || null,
    });
  }
});

export default router;
