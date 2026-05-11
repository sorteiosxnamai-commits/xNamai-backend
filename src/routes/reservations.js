// backend/src/routes/reservations.js
import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { getTicketPriceCents } from '../services/config.js';
import { mpCreatePixPayment } from '../services/mercadopago.js';

const router = Router();

async function ensureReservationPaymentColumns() {
  await query(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending'`);
  await query(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS buyer_name TEXT`);
  await query(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS buyer_email TEXT`);
  await query(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS buyer_phone TEXT`);
  await query(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);
}

function getBaseUrl(req) {
  const publicUrl = process.env.PUBLIC_URL ? String(process.env.PUBLIC_URL).replace(/\/$/, '') : '';
  if (publicUrl) return publicUrl;

  const protoRaw = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const proto = String(protoRaw).split(',')[0].trim() || 'https';
  const host = req.get('host');
  let baseUrl = `${proto}://${host}`.replace(/\/$/, '');
  if (process.env.NODE_ENV === 'production' && !baseUrl.startsWith('https://')) {
    baseUrl = baseUrl.replace(/^http:\/\//, 'https://');
  }
  return baseUrl;
}

/**
 * Expira reservas vencidas (best-effort, fora da transação principal).
 * Mantido para “limpeza geral”; a expiração crítica também acontece
 * dentro da transação ao reservar (garante consistência).
 */
async function cleanupExpiredGlobal() {
  // expira qualquer reserva “bloqueadora” vencida
  await query(
    `UPDATE reservations
        SET status = 'expired'
      WHERE expires_at IS NOT NULL
        AND expires_at < NOW()
        AND lower(coalesce(status,'')) IN ('active','pending','reserved','')`
  );

  // libera números que ficaram presos com reservation_id sem reserva ativa
  await query(
    `UPDATE numbers n
        SET status = 'available',
            reservation_id = NULL
      WHERE n.status = 'reserved'
        AND NOT EXISTS (
              SELECT 1
                FROM reservations r
               WHERE r.id = n.reservation_id
                 AND lower(coalesce(r.status,'')) IN ('active','pending','reserved','')
            )`
  );
}

router.post('/', requireAuth, async (req, res) => {
  const DBG = process.env.DEBUG_RESERVATIONS === 'true';

  try {
    await ensureReservationPaymentColumns();

    if (DBG) {
      console.log('[reservations] origin =', req.headers.origin || '(none)');
      console.log('[reservations] auth header =', !!req.headers.authorization);
      console.log(
        '[reservations] user =',
        req.user ? { id: req.user.id, email: req.user.email } : '(none)'
      );
    }

    // limpeza “background” (não bloqueia o request)
    try { cleanupExpiredGlobal(); } catch {}

    const { numbers } = req.body || {};
    if (!Array.isArray(numbers) || numbers.length === 0) {
      return res.status(400).json({ error: 'no_numbers' });
    }

    // normaliza números
    const nums = Array.from(
      new Set(
        numbers.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 99)
      )
    );
    if (!nums.length) return res.status(400).json({ error: 'numbers_invalid' });

    const ttlMin = Number(process.env.RESERVATION_TTL_MIN || 5);

    // draw aberto
    const dr = await query(
      `SELECT id
         FROM draws
        WHERE status = 'open'
     ORDER BY id DESC
        LIMIT 1`
    );
    if (!dr.rows.length) return res.status(400).json({ error: 'no_open_draw' });
    const drawId = dr.rows[0].id;

    // === INÍCIO TX ===========================================================
    await query('BEGIN');

    // 1) Lock nos números alvo
    const check = await query(
      `SELECT n, status, reservation_id
         FROM numbers
        WHERE draw_id = $1
          AND n = ANY($2)
        FOR UPDATE`,
      [drawId, nums]
    );

    // valida existência
    const foundSet = new Set(check.rows.map((r) => r.n));
    const notFound = nums.filter((n) => !foundSet.has(n));
    if (notFound.length) {
      await query('ROLLBACK');
      return res.status(400).json({ error: 'numbers_not_found', numbers: notFound });
    }

    // 2) Para cada número “reserved”, se a reserva estiver vencida, libera AGORA
    const byResId = new Map(); // agrupa números por reservation_id para liberar em lote
    for (const row of check.rows) {
      if (row.status === 'reserved' && row.reservation_id) {
        const rid = row.reservation_id;

        // lock na reserva para leitura consistente
        const rsv = await query(
          `SELECT id, status, expires_at
             FROM reservations
            WHERE id = $1
            FOR UPDATE`,
          [rid]
        );

        const r = rsv.rows[0];
        if (r) {
          const statusLower = String(r.status || '').toLowerCase();
          const isBlocking = ['active','pending','reserved',''].includes(statusLower);
          const isExpired = r.expires_at && new Date(r.expires_at).getTime() <= Date.now();

          if (isBlocking && isExpired) {
            // expira a reserva e marca para liberar seus números
            await query(`UPDATE reservations SET status = 'expired' WHERE id = $1`, [rid]);
            if (!byResId.has(rid)) byResId.set(rid, []);
            byResId.get(rid).push(row.n);
          }
        }
      }
    }

    // libera números presos por reservas expiradas (em lote por reservation_id)
    for (const [rid, numsOfRid] of byResId) {
      await query(
        `UPDATE numbers
            SET status = 'available',
                reservation_id = NULL
          WHERE draw_id = $1
            AND n = ANY($2)
            AND reservation_id = $3`,
        [drawId, numsOfRid, rid]
      );
    }

    // 3) Números tomados por pagamento aprovado
    const pays = await query(
      `SELECT numbers
         FROM payments
        WHERE draw_id = $1
          AND lower(status) IN ('approved','paid','pago')`,
      [drawId]
    );
    const paidTaken = new Set();
    for (const p of pays.rows || []) {
      for (const n of p.numbers || []) paidTaken.add(Number(n));
    }

    // 4) Revalida os números (após possíveis liberações) e detecta conflitos
    const after = await query(
      `SELECT n, status, reservation_id
         FROM numbers
        WHERE draw_id = $1
          AND n = ANY($2)
        FOR UPDATE`,
      [drawId, nums]
    );

    const conflicts = [];
    for (const row of after.rows) {
      const st = String(row.status).toLowerCase();
      const isBusy = st !== 'available' || paidTaken.has(Number(row.n));
      if (isBusy) conflicts.push(row.n);
    }

    if (conflicts.length) {
      await query('ROLLBACK');
      return res.status(409).json({ error: 'unavailable', conflicts });
    }

    // 5) Cria reserva e marca números como reserved
    const reservationId = uuid();
    const expiresAt = new Date(Date.now() + ttlMin * 60 * 1000);

    await query(
      `INSERT INTO reservations (
        id,
        user_id,
        draw_id,
        numbers,
        status,
        payment_status,
        buyer_name,
        buyer_email,
        expires_at
      )
       VALUES ($1, $2, $3, $4::int[], 'reserved', 'pending', $5, $6, $7)`,
      [
        reservationId,
        req.user.id,
        drawId,
        nums,
        req.user?.name || req.user?.nome || req.user?.email || null,
        req.user?.email || null,
        expiresAt,
      ]
    );

    await query(
      `UPDATE numbers
          SET status = 'reserved',
              reservation_id = $3
        WHERE draw_id = $1
          AND n = ANY($2)`,
      [drawId, nums, reservationId]
    );

    await query('COMMIT');
    // === FIM TX ==============================================================

    if (DBG) {
      console.log('[reservations] created', {
        reservationId,
        userId: req.user.id,
        drawId,
        numbers: nums,
        expiresAt: expiresAt.toISOString(),
      });
    }

    return res
      .status(201)
      .json({
        reservationId,
        id: reservationId,
        drawId,
        expiresAt,
        numbers: nums,
        payment_status: 'pending',
        status: 'reserved',
        can_pay: true,
      });
  } catch (e) {
    try { await query('ROLLBACK'); } catch {}
    console.error('[reservations] error:', e.code || e.message, e);
    return res.status(500).json({ error: 'reserve_failed' });
  }
});

router.post('/:reservationId/pix', requireAuth, async (req, res) => {
  try {
    await ensureReservationPaymentColumns();

    const reservationId = req.params.reservationId;
    const r = await query(
      `SELECT r.id,
              r.user_id,
              r.draw_id,
              r.numbers,
              r.status,
              r.payment_status,
              r.expires_at,
              u.email AS user_email,
              u.name AS user_name
         FROM reservations r
    LEFT JOIN users u ON u.id = r.user_id
        WHERE r.id = $1
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

    if (reservation.expires_at && new Date(reservation.expires_at).getTime() < Date.now()) {
      return res.status(400).json({
        ok: false,
        error: 'Reserva expirada.',
      });
    }

    const priceCents = await getTicketPriceCents();
    const numbers = Array.isArray(reservation.numbers) ? reservation.numbers.map(Number) : [];
    const amountCents = numbers.length * priceCents;

    const pix = await mpCreatePixPayment({
      amount_cents: amountCents,
      description: `Sorteio xNaMai - números ${numbers.map((n) => String(n).padStart(2, '0')).join(', ')}`,
      payer_email: reservation.user_email || req.user.email,
      payer_name: reservation.user_name || req.user.name || req.user.email,
      external_reference: String(reservationId),
      notification_url: `${getBaseUrl(req)}/api/payments/webhook`,
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
      `INSERT INTO payments (id, user_id, draw_id, numbers, amount_cents, status, qr_code, qr_code_base64)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE
         SET status = EXCLUDED.status,
             qr_code = COALESCE(EXCLUDED.qr_code, payments.qr_code),
             qr_code_base64 = COALESCE(EXCLUDED.qr_code_base64, payments.qr_code_base64)`,
      [
        pix.payment_id,
        req.user.id,
        reservation.draw_id,
        numbers,
        amountCents,
        pix.status,
        pix.qr_code || null,
        pix.qr_code_base64 || null,
      ]
    );

    await query(
      `UPDATE reservations
          SET payment_id = $2,
              payment_status = 'pending',
              updated_at = NOW()
        WHERE id = $1`,
      [reservationId, pix.payment_id]
    );

    return res.json({
      ok: true,
      payment_id: pix.payment_id,
      reservation_id: reservationId,
      qr_code: pix.qr_code,
      qr_code_base64: pix.qr_code_base64,
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
