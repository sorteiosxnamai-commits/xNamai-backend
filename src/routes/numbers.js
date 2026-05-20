// backend/src/routes/numbers.js
import { Router } from 'express';
import { query } from '../db.js';
import { cleanupExpiredMainReservations } from '../services/mainReservationExpiry.js';

const router = Router();

const ADMIN_SOURCES = new Set(['admin', 'manual', 'admin_manual']);

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

router.get('/', async (req, res) => {
  try {
    const requestedDrawId = Number(req.query.draw_id || req.query.drawId || 0);
    let drawId = null;

    if (Number.isInteger(requestedDrawId) && requestedDrawId > 0) {
      const dr = await query(`SELECT id FROM public.draws WHERE id = $1 LIMIT 1`, [requestedDrawId]);
      if (!dr.rows.length) {
        return res.status(404).json({ ok: false, error: 'draw_not_found', drawId: requestedDrawId, numbers: [] });
      }
      drawId = Number(dr.rows[0].id);
    } else {
      const dr = await query(`SELECT id FROM public.draws WHERE status = 'open' ORDER BY id DESC LIMIT 1`);
      if (!dr.rows.length) {
        return res.json({ ok: true, drawId: null, draw_id: null, numbers: [] });
      }
      drawId = Number(dr.rows[0].id);
    }

    await cleanupExpiredMainReservations(null, drawId);

    const reservationMeta = await query(
      `SELECT id::text AS id, reservation_group_id::text AS group_id,
              LOWER(COALESCE(source, 'public')) AS source, status, payment_status,
              COALESCE(expires_at, created_at + interval '30 minutes') AS effective_expires_at
         FROM public.reservations WHERE draw_id = $1`,
      [drawId]
    );

    const reservationByLink = new Map();
    const expiredLinkIds = new Set();
    const now = Date.now();

    for (const row of reservationMeta.rows || []) {
      const meta = {
        source: row.source,
        status: String(row.status || '').toLowerCase(),
        payment_status: String(row.payment_status || 'pending').toLowerCase(),
        expired:
          new Date(row.effective_expires_at).getTime() <= now ||
          ['expired', 'cancelled', 'canceled'].includes(String(row.status || '').toLowerCase()),
      };
      if (row.id) reservationByLink.set(String(row.id), meta);
      if (row.group_id) reservationByLink.set(String(row.group_id), meta);
      if (meta.expired) {
        if (row.id) expiredLinkIds.add(String(row.id));
        if (row.group_id) expiredLinkIds.add(String(row.group_id));
      }
    }

    const pays = await query(
      `SELECT num.n::int AS n, u.name AS owner_name, u.email AS owner_email
         FROM public.payments p
         LEFT JOIN public.users u ON u.id = p.user_id
         CROSS JOIN LATERAL UNNEST(COALESCE(p.numbers, '{}'::int[])) AS num(n)
        WHERE p.draw_id = $1
          AND LOWER(COALESCE(p.status, '')) IN ('approved', 'paid', 'pago')`,
      [drawId]
    );

    const initialsByN = new Map();
    for (const row of pays.rows || []) {
      const num = Number(row.n);
      if (!Number.isInteger(num)) continue;
      initialsByN.set(num, initialsFromNameOrEmail(row.owner_name, row.owner_email));
    }

    const base = await query(
      `SELECT COALESCE(n::int, number) AS n, status, payment_status, reserved_until,
              reserved_at, user_id, reservation_id, payment_id
         FROM public.numbers WHERE draw_id = $1
         ORDER BY COALESCE(n::int, number) ASC`,
      [drawId]
    );

    const numbers = base.rows
      .map((row) => {
        const num = Number(row.n);
        if (!Number.isInteger(num)) return null;
        const status = String(row.status || 'available').toLowerCase();
        const paymentStatus = String(row.payment_status || 'pending').toLowerCase();
        const reservedUntilMs = row.reserved_until ? new Date(row.reserved_until).getTime() : null;
        const isPaid =
          ['sold', 'paid', 'approved', 'pago', 'vendido', 'aprovado'].includes(status) ||
          ['paid', 'approved', 'pago'].includes(paymentStatus) ||
          initialsByN.has(num);

        if (isPaid) {
          return {
            n: num, number: num, label: String(num).padStart(2, '0'),
            status: 'sold', payment_status: 'paid',
            owner_initials: initialsByN.get(num) || null,
            reserved_until: row.reserved_until || null,
          };
        }

        const isReservedStatus = ['reserved', 'pending', 'reservado', 'pendente'].includes(status);
        const reservationLink = row.reservation_id ? String(row.reservation_id) : null;
        const linkedReservation = reservationLink ? reservationByLink.get(reservationLink) : null;
        const linkedToExpiredReservation =
          reservationLink && (expiredLinkIds.has(reservationLink) || linkedReservation?.expired);
        const isPublicSource = !linkedReservation || !ADMIN_SOURCES.has(linkedReservation.source);
        const isTemporaryReservation =
          isReservedStatus && reservedUntilMs && reservedUntilMs > now && !linkedToExpiredReservation;
        const isAdminPermanentReservation =
          isReservedStatus && !reservedUntilMs && row.user_id != null &&
          !linkedToExpiredReservation && !isPublicSource &&
          linkedReservation && ADMIN_SOURCES.has(linkedReservation.source);

        if (isTemporaryReservation || isAdminPermanentReservation) {
          return {
            n: num, number: num, label: String(num).padStart(2, '0'),
            status: 'reserved', payment_status: paymentStatus || 'pending',
            reserved_until: row.reserved_until || null,
            permanent: Boolean(isAdminPermanentReservation),
          };
        }

        return {
          n: num, number: num, label: String(num).padStart(2, '0'),
          status: 'available', payment_status: paymentStatus || 'pending', reserved_until: null,
        };
      })
      .filter(Boolean);

    return res.json({ ok: true, drawId, draw_id: drawId, numbers });
  } catch (err) {
    console.error('[MAIN_NUMBERS_LIST_ERROR]', err?.message);
    return res.status(500).json({
      ok: false, error: 'failed_to_list_numbers',
      message: err?.message || 'Falha ao listar números.',
    });
  }
});

export default router;
