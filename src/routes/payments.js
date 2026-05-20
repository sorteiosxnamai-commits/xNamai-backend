// src/routes/payments.js
import { Router } from 'express';
import { MercadoPagoConfig, Payment } from 'mercadopago';
import { query, ensureUserProfileColumns } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { getTicketPriceCents } from '../services/config.js';
import { creditCouponOnApprovedPayment } from '../services/couponBalance.js';
import { ensureMainRaffleCompat } from '../services/mainRaffleCompat.js';
import {
  buildMercadoPagoPixPayload,
  normalizeCpf,
  parseBrazilPhone,
  maskDocument,
} from '../utils/mercadoPagoPayload.js';

const router = Router();

// Aceita MP_ACCESS_TOKEN (backend) ou REACT_APP_MP_ACCESS_TOKEN (Render)
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN || process.env.REACT_APP_MP_ACCESS_TOKEN,
});
const mpPayment = new Payment(mpClient);

const PIX_EXP_MIN = Math.max(
  30,
  Number(process.env.PIX_EXP_MIN || process.env.PIX_EXP_MINUTES || 30)
);

function isDebugCouponEnabled() {
  const v = String(process.env.DEBUG_COUPON || "").toLowerCase().trim();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function isDebugMpEnabled() {
  const v = String(process.env.DEBUG_MP || "").toLowerCase().trim();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const APPROVED_PAYMENT_STATUSES = new Set(['approved', 'paid', 'pago']);

function normalizePaymentStatus(status) {
  return String(status || '').trim().toLowerCase();
}

function isApprovedPaymentStatus(status) {
  return APPROVED_PAYMENT_STATUSES.has(normalizePaymentStatus(status));
}

function normalizeNumbersList(value) {
  if (Array.isArray(value)) {
    return value
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 99);
  }

  if (typeof value === 'string') {
    return value
      .replace(/[{}[\]\s]/g, '')
      .split(',')
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 99);
  }

  return [];
}

async function creditCouponForApprovedPix(paymentId, source, meta = {}) {
  try {
    const creditResult = await creditCouponOnApprovedPayment(String(paymentId), {
      channel: 'PIX',
      source,
      runTraceId: meta?.runTraceId != null ? String(meta.runTraceId) : null,
      meta,
    });
    console.log('[PIX_APPROVED_CASHBACK]', { paymentId: String(paymentId), source, result: creditResult });
    return creditResult;
  } catch (creditErr) {
    console.warn('[PIX_APPROVED_CASHBACK_WARN]', {
      paymentId: String(paymentId),
      source,
      message: creditErr?.message,
      code: creditErr?.code,
    });
    return null;
  }
}

/**
 * Fecha o draw se tiver 100 vendidos e cria um novo se não existir outro 'open'.
 * Tudo dentro de TRANSAÇÃO + ADVISORY LOCK para evitar condições de corrida.
 */
async function finalizeDrawIfComplete(drawId) {
  // Inicia transação e trava seção crítica
  await query('BEGIN');
  try {
    // trava global simples (escopo transação)
    await query('SELECT pg_advisory_xact_lock(911001)');

    // Trava a linha do draw e revalida status
    const cur = await query(
      `SELECT id, status, closed_at
         FROM draws
        WHERE id = $1
        FOR UPDATE`,
      [drawId]
    );

    if (!cur.rows.length) {
      await query('ROLLBACK');
      return;
    }

    // Reconta vendidos sob a mesma transação
    const cnt = await query(
      `SELECT COUNT(*)::int AS sold
         FROM numbers
        WHERE draw_id = $1 AND status = 'sold'`,
      [drawId]
    );
    const sold = cnt.rows[0]?.sold || 0;

    if (sold === 100) {
      // Fecha (idempotente)
      await query(
        `UPDATE draws
            SET status = 'closed',
                closed_at = COALESCE(closed_at, NOW())
          WHERE id = $1`,
        [drawId]
      );

      // Abre novo SOMENTE se não existir outro aberto
      const ins = await query(
        `WITH chk AS (
           SELECT 1 FROM draws WHERE status = 'open' LIMIT 1
         )
         INSERT INTO draws (status)
         SELECT 'open'
         WHERE NOT EXISTS (SELECT 1 FROM chk)
         RETURNING id`
      );

      const newId = ins.rows[0]?.id;
      if (newId) {
        // Popula 0..99
        await query(
          `INSERT INTO numbers (draw_id, n, status)
           SELECT $1, gs, 'available'
             FROM generate_series(0, 99) AS gs`,
          [newId]
        );
      }
    }

    await query('COMMIT');
  } catch (e) {
    try { await query('ROLLBACK'); } catch {}
    // Loga e segue; idempotência garante consistência em nova tentativa
    console.error('[finalizeDrawIfComplete] error:', e);
  }
}

/**
 * Marca números como vendidos para um pagamento aprovado
 * e marca a reserva (se houver) como 'paid'.
 */
async function settleApprovedPayment(paymentId, fallbackDrawId = null, fallbackNumbers = []) {
  await ensureMainRaffleCompat();

  const cleanPaymentId = String(paymentId || '').trim();

  if (!cleanPaymentId) {
    console.warn('[SETTLE_APPROVED_PAYMENT_SKIP] missing paymentId');
    return {
      ok: false,
      reason: 'missing_payment_id',
    };
  }

  const paymentRes = await query(
    `
      SELECT
        id,
        user_id,
        draw_id,
        numbers,
        amount_cents,
        status,
        coupon_credited
      FROM payments
      WHERE id = $1
      LIMIT 1
    `,
    [cleanPaymentId]
  );

  const payment = paymentRes.rows[0] || null;

  const drawId = Number(payment?.draw_id || fallbackDrawId || 0);
  const userId = Number(payment?.user_id || 0);
  const numbers = normalizeNumbersList(
    payment?.numbers && normalizeNumbersList(payment.numbers).length
      ? payment.numbers
      : fallbackNumbers
  );

  if (!drawId || !numbers.length) {
    console.warn('[SETTLE_APPROVED_PAYMENT_SKIP]', {
      paymentId: cleanPaymentId,
      drawId,
      numbers,
    });

    return {
      ok: false,
      reason: 'missing_draw_or_numbers',
      paymentId: cleanPaymentId,
      drawId,
      numbers,
    };
  }

  await query('BEGIN');

  try {
    await query(
      `
        UPDATE payments
           SET status = 'approved',
               paid_at = COALESCE(paid_at, NOW())
         WHERE id = $1
      `,
      [cleanPaymentId]
    );

    await query(
      `
        UPDATE numbers
           SET status = 'sold',
               payment_status = 'paid',
               payment_id = $1,
               reserved_until = NULL,
               reservation_id = NULL
         WHERE draw_id = $2
           AND n = ANY($3::int[])
      `,
      [cleanPaymentId, drawId, numbers]
    );

    await query(
      `
        UPDATE reservations
           SET status = 'paid',
               payment_status = 'paid',
               payment_id = $1
         WHERE payment_id = $1
            OR (
              draw_id = $2
              AND user_id = $3
              AND numbers && $4::int[]
            )
      `,
      [cleanPaymentId, drawId, userId || null, numbers]
    );

    await query('COMMIT');

    console.log('[SETTLE_APPROVED_PAYMENT_OK]', {
      paymentId: cleanPaymentId,
      drawId,
      userId,
      numbers,
    });

    return {
      ok: true,
      paymentId: cleanPaymentId,
      drawId,
      userId,
      numbers,
    };
  } catch (err) {
    await query('ROLLBACK');

    console.error('[SETTLE_APPROVED_PAYMENT_ERROR]', {
      paymentId: cleanPaymentId,
      drawId,
      numbers,
      message: err?.message,
      code: err?.code,
    });

    throw err;
  }
}

/**
 * Varre pagamentos não aprovados nos últimos N minutos, reconcilia e assenta.
 * Reutilizada pelo endpoint /reconcile e pelo middleware autoReconcile.
 */
async function _reconcilePendingPaymentsCore(minutes) {
  const lookbackMin = Math.max(5, Number(minutes || 1440)); // default 24h
  const { rows } = await query(
    `SELECT id
       FROM payments
      WHERE lower(status) NOT IN ('approved','paid','pago')
        AND COALESCE(created_at, now()) >= NOW() - ($1::int || ' minutes')::interval`,
    [lookbackMin]
  );

  let scanned = rows.length, updated = 0, approved = 0, failed = 0;

  for (const { id } of rows) {
    try {
      const resp = await mpPayment.get({ id: String(id) });
      const body = resp?.body || resp;
      const rawStatus = body?.status || body?.payment_status || 'pending';
      const approvedNow = isApprovedPaymentStatus(rawStatus);

      if (approvedNow) {
        const pr = await query(`SELECT draw_id, numbers FROM payments WHERE id = $1`, [id]);
        if (pr.rows.length) {
          const { draw_id, numbers } = pr.rows[0];
          await settleApprovedPayment(id, draw_id, numbers);
          await creditCouponForApprovedPix(id, 'reconcile_sync', {
            draw_id,
            numbers,
            unit_cents: 5500,
          });
          approved++;
        }
        updated++;
      } else {
        await query(
          `UPDATE payments SET status = $2 WHERE id = $1`,
          [id, normalizePaymentStatus(rawStatus)]
        );
        updated++;
      }
    } catch (e) {
      failed++;
      console.warn('[reconcile] error for id', id, e?.message || e);
    }
  }

  return { scanned, updated, approved, failed, minutes: lookbackMin };
}

/**
 * Exportado para uso pelo middleware autoReconcile (app.use(autoReconcile))
 * Roda em background; qualquer erro é tratado aqui para não quebrar o servidor.
 */
export async function kickReconcilePendingPayments(minutes) {
  try {
    const lookback =
      minutes ??
      Number(process.env.RECONCILE_LOOKBACK_MIN || process.env.RECONCILE_MINUTES || 1440);
    const res = await _reconcilePendingPaymentsCore(lookback);
    if (res?.approved) {
      console.log('[autoReconcile] aprovados:', res.approved, '— janela (min):', res.minutes);
    }
    return res;
  } catch (e) {
    console.warn('[autoReconcile] fatal:', e?.message || e);
    return { scanned: 0, updated: 0, approved: 0, failed: 1, error: String(e?.message || e) };
  }
}

// -----------------------------------------------------------------------------
// Rotas
// -----------------------------------------------------------------------------

/**
 * POST /api/payments/pix
 * Body: { reservationId }
 * Auth: Bearer
 */
router.post('/pix', requireAuth, async (req, res) => {
  console.log('[payments/pix] user=', req.user?.id, 'body=', req.body);
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'unauthorized' });

    const { reservationId } = req.body || {};
    if (!reservationId) {
      return res.status(400).json({ error: 'missing_reservation' });
    }

    // Carrega a reserva + (opcional) usuário
    const r = await query(
      `SELECT r.id, r.user_id, r.draw_id, r.numbers, r.status, r.payment_status, r.expires_at,
              u.email AS user_email, u.name AS user_name
         FROM reservations r
    LEFT JOIN users u ON u.id = r.user_id
        WHERE r.id = $1`,
      [reservationId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'reservation_not_found' });

    const rs = r.rows[0];

    if (Number(rs.user_id) !== Number(req.user.id)) {
      return res.status(403).json({
        ok: false,
        error: 'Você não tem permissão para pagar esta reserva.',
      });
    }

    if (!['active', 'reserved', 'open', 'pending'].includes(String(rs.status || '').toLowerCase())) {
      return res.status(400).json({ error: 'reservation_not_active' });
    }
    if (String(rs.payment_status || 'pending').toLowerCase() !== 'pending') {
      return res.status(400).json({ error: 'payment_not_pending' });
    }
    if (rs.expires_at && new Date(rs.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: 'reservation_expired' });
    }

    // Valor (preço * quantidade) — vindo do banco
    const priceCents = await getTicketPriceCents();
    const amountCents = rs.numbers.length * priceCents;
    const amount = Number((amountCents / 100).toFixed(2));

    const publicUrl = process.env.PUBLIC_URL ? String(process.env.PUBLIC_URL).replace(/\/$/, '') : '';
    let baseUrl = publicUrl;
    if (!baseUrl) {
      const protoRaw = req.headers['x-forwarded-proto'] || req.protocol || 'https';
      const proto = String(protoRaw).split(',')[0].trim() || 'https';
      const host = req.get('host');
      let fallback = `${proto}://${host}`.replace(/\/$/, '');
      if (process.env.NODE_ENV === 'production' && !fallback.startsWith('https://')) {
        fallback = fallback.replace(/^http:\/\//, 'https://');
      }
      baseUrl = fallback;
    }
    const notificationUrl = `${baseUrl}/api/payments/webhook`;
    if (isDebugMpEnabled()) {
      console.log('[mp.pix] notification_url=', notificationUrl);
    }

    const expirationDate = new Date(Date.now() + PIX_EXP_MIN * 60 * 1000).toISOString();

    await ensureUserProfileColumns();

    const userResult = await query(
      `
      SELECT
        id,
        name,
        email,
        cpf,
        phone,
        zip_code,
        street,
        street_number,
        neighborhood,
        city,
        state,
        created_at
      FROM public.users
      WHERE id = $1
      LIMIT 1
      `,
      [rs.user_id]
    );

    const dbUser = userResult.rows[0] || {};
    const incomingPayer = req.body?.payer || req.body?.customer || {};

    const safeUser = {
      ...dbUser,

      id:
        dbUser?.id ||
        rs.user_id ||
        req.user?.id ||
        incomingPayer?.id ||
        null,

      name:
        dbUser?.name ||
        rs.user_name ||
        req.user?.name ||
        incomingPayer?.name ||
        incomingPayer?.full_name ||
        'Cliente xNaMai',

      email:
        dbUser?.email ||
        rs.user_email ||
        req.user?.email ||
        incomingPayer?.email ||
        '',

      cpf:
        dbUser?.cpf ||
        incomingPayer?.cpf ||
        incomingPayer?.document ||
        incomingPayer?.document_number ||
        '',

      phone:
        dbUser?.phone ||
        incomingPayer?.phone ||
        incomingPayer?.phone_number ||
        incomingPayer?.buyer_phone ||
        '',

      zip_code:
        dbUser?.zip_code ||
        incomingPayer?.zip_code ||
        incomingPayer?.cep ||
        '',

      street:
        dbUser?.street ||
        incomingPayer?.street ||
        incomingPayer?.street_name ||
        '',

      street_number:
        dbUser?.street_number ||
        incomingPayer?.street_number ||
        incomingPayer?.number ||
        '',

      neighborhood:
        dbUser?.neighborhood ||
        incomingPayer?.neighborhood ||
        incomingPayer?.district ||
        '',

      city:
        dbUser?.city ||
        incomingPayer?.city ||
        '',

      state:
        dbUser?.state ||
        incomingPayer?.state ||
        incomingPayer?.uf ||
        '',

      created_at:
        dbUser?.created_at ||
        incomingPayer?.created_at ||
        null,
    };

    if (!safeUser.email) {
      return res.status(400).json({
        ok: false,
        code: 'missing_email',
        message: 'Não foi possível gerar o PIX porque o usuário não possui e-mail cadastrado.',
      });
    }

    const drawResult = await query(
      `SELECT id, status FROM public.draws WHERE id = $1 LIMIT 1`,
      [rs.draw_id]
    );
    const draw = drawResult.rows[0] || { id: rs.draw_id };

    const mpPayload = buildMercadoPagoPixPayload({
      user: safeUser,
      draw,
      reservation: rs,
      numbers: rs.numbers,
      amountCents,
      ticketPriceCents: priceCents,
      reservationId,
      notificationUrl,
      expirationDate,
    });

    console.log('[MP_PIX_PAYLOAD_SUMMARY]', {
      reservation_id: reservationId,
      user_id: safeUser?.id,
      email_present: Boolean(safeUser?.email),
      cpf_present: Boolean(normalizeCpf(safeUser?.cpf)),
      cpf_masked: maskDocument(safeUser?.cpf),
      phone_present: Boolean(parseBrazilPhone(safeUser?.phone)),
      zip_present: Boolean(safeUser?.zip_code),
      street_present: Boolean(safeUser?.street),
      street_number_present: Boolean(safeUser?.street_number),
      city_present: Boolean(safeUser?.city),
      state_present: Boolean(safeUser?.state),
      numbers_count: Array.isArray(rs.numbers) ? rs.numbers.length : 0,
      amount_cents: amountCents,
    });

    const mpAccessToken =
      process.env.MP_ACCESS_TOKEN || process.env.REACT_APP_MP_ACCESS_TOKEN;
    const idempotencyKey = `xnamai-main-${reservationId}`;

    const mpResponse = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mpAccessToken}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(mpPayload),
    });

    const mpData = await mpResponse.json().catch(() => ({}));

    if (!mpResponse.ok) {
      console.error('[MP_PIX_CREATE_ERROR]', {
        status: mpResponse.status,
        reservation_id: reservationId,
        user_id: safeUser?.id,
        message: mpData?.message,
        error: mpData?.error,
        cause: mpData?.cause,
      });

      return res.status(400).json({
        ok: false,
        code: 'mercado_pago_payment_rejected',
        message:
          mpData?.message ||
          'Pagamento recusado pelo Mercado Pago. Verifique os detalhes técnicos retornados pelo provedor.',
        provider_error: mpData?.error || null,
        provider_status: mpResponse.status,
        provider_cause: Array.isArray(mpData?.cause) ? mpData.cause : [],
      });
    }

    const body = mpData;
    const { id, status, point_of_interaction } = body || {};
    if (isDebugMpEnabled()) {
      console.log('[mp.pix] created payment', { id: id != null ? String(id) : null, status: status || null });
    }
    const td = point_of_interaction?.transaction_data || {};

    // Normaliza QR/copia-e-cola
    let { qr_code, qr_code_base64, ticket_url } = td;
    if (typeof qr_code_base64 === 'string') qr_code_base64 = qr_code_base64.replace(/\s+/g, '');
    if (typeof qr_code === 'string') qr_code = qr_code.trim();
    ticket_url = ticket_url || body?.transaction_details?.external_resource_url || '';

    const drawId = Number(rs.draw_id);
    const userId = Number(rs.user_id || req.user.id);
    const numbers = rs.numbers;
    const createdStatus = normalizePaymentStatus(status);

    // Persiste o pagamento
    await query(
      `INSERT INTO payments (id, user_id, draw_id, numbers, amount_cents, status, qr_code, qr_code_base64)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE
         SET status = EXCLUDED.status,
             qr_code = COALESCE(EXCLUDED.qr_code, payments.qr_code),
             qr_code_base64 = COALESCE(EXCLUDED.qr_code_base64, payments.qr_code_base64)`,
      [
        String(id),
        userId,
        drawId,
        numbers,
        amountCents,
        createdStatus,
        qr_code || null,
        qr_code_base64 || null,
      ]
    );

    // Amarra a reserva ao pagamento
    await query(
      `UPDATE reservations
          SET payment_id = $2,
              payment_status = $3,
              amount_cents = COALESCE(amount_cents, $4),
              pix_qr_code = $5,
              pix_qr_code_base64 = $6,
              pix_copy_paste = $5,
              updated_at = NOW()
        WHERE id = $1`,
      [
        reservationId,
        String(id),
        isApprovedPaymentStatus(status) ? 'paid' : 'pending',
        amountCents,
        qr_code || null,
        qr_code_base64 || null,
      ]
    );

    if (isApprovedPaymentStatus(status)) {
      console.log('[MP_PIX_CREATED_ALREADY_APPROVED]', {
        paymentId: id,
        drawId,
        userId,
        numbers,
      });

      await settleApprovedPayment(String(id), drawId, numbers);

      await creditCouponForApprovedPix(String(id), 'mercadopago_create_immediate_approved', {
        runTraceId: `mp.create.approved#${String(id)}`,
        draw_id: drawId,
        numbers,
        amount_cents: amountCents,
        reservation_id: reservationId,
      });
    }

    return res.json({
      ok: true,
      payment_id: String(id),
      paymentId: String(id),
      reservation_id: reservationId,
      status: createdStatus,
      qr_code,
      qr_code_base64,
      copy_paste: qr_code,
      ticket_url,
      amount,
      payment_status: isApprovedPaymentStatus(status) ? 'paid' : 'pending',
    });
  } catch (e) {
    console.error('[MAIN_PIX_ERROR]', {
      code: e?.code,
      message: e?.message,
      detail: e?.detail,
      hint: e?.hint,
      stack: e?.stack,
    });
    return res.status(500).json({ ok: false, error: 'Erro ao gerar PIX da reserva.', code: e?.code || 'MAIN_PIX_ERROR' });
  }
});

/**
 * GET /api/payments/:id/status
 * Auth: Bearer
 */
router.get('/:id/status', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const resp = await mpPayment.get({ id: String(id) });
    const body = resp?.body || resp;

    const rawStatus = body?.status || body?.payment_status || 'pending';
    const approvedNow = isApprovedPaymentStatus(rawStatus);

    if (approvedNow) {
      const pr = await query(`SELECT draw_id, numbers FROM payments WHERE id = $1`, [id]);
      if (pr.rows.length) {
        const p = pr.rows[0];
        await settleApprovedPayment(String(id), p.draw_id, p.numbers);
        await creditCouponForApprovedPix(String(id), 'mercadopago_status_check', {
          runTraceId: `mp.status#${String(id)}`,
          numbers: p.numbers,
          draw_id: p.draw_id,
        });
      }
      return res.json({ id, status: 'approved' });
    }

    const normalizedStatus = normalizePaymentStatus(rawStatus);
    await query(
      `UPDATE payments SET status = $2 WHERE id = $1`,
      [String(id), normalizedStatus]
    );

    return res.json({ id, status: normalizedStatus });
  } catch (e) {
    console.error('[status] error:', e);
    return res.status(500).json({ error: 'status_failed' });
  }
});

/**
 * POST /api/payments/webhook
 * Body: evento do Mercado Pago
 */
router.post('/webhook', async (req, res) => {
  try {
    const paymentId = req.body?.data?.id || req.query?.id || req.body?.id;
    const type = req.body?.type || req.query?.type;

    if (type && type !== 'payment') return res.sendStatus(200);
    if (!paymentId) return res.sendStatus(200);

    const resp = await mpPayment.get({ id: String(paymentId) });
    const body = resp?.body || resp;

    const id = String(body.id);
    const rawStatus = body?.status || body?.payment_status || 'pending';
    const approvedNow = isApprovedPaymentStatus(rawStatus);

    if (approvedNow) {
      const pr = await query(`SELECT draw_id, numbers FROM payments WHERE id = $1`, [id]);
      if (pr.rows.length) {
        const p = pr.rows[0];
        await settleApprovedPayment(id, p.draw_id, p.numbers);
        await creditCouponForApprovedPix(id, 'mercadopago_webhook', {
          runTraceId: req.headers['x-request-id'] ? String(req.headers['x-request-id']) : null,
          numbers: p.numbers,
          draw_id: p.draw_id,
        });
      }
    } else {
      await query(
        `UPDATE payments SET status = $2 WHERE id = $1`,
        [id, normalizePaymentStatus(rawStatus)]
      );
    }

    // Sempre 200 para o MP não reenfileirar indefinidamente
    return res.sendStatus(200);
  } catch (e) {
    console.error('[webhook] error:', e);
    return res.sendStatus(200);
  }
});

// === LISTA MEUS PAGAMENTOS (para a conta) ===
// GET /api/payments/me  -> { payments: [...] }
router.get('/me', requireAuth, async (req, res) => {
  try {
    const r = await query(
      `SELECT id,
              user_id,
              draw_id,
              numbers,
              amount_cents,
              status,
              created_at,
              paid_at
         FROM payments
        WHERE user_id = $1
        ORDER BY COALESCE(paid_at, created_at) ASC`,
      [req.user.id]
    );
    return res.json({ payments: r.rows || [] });
  } catch (e) {
    console.error('[payments/me] error:', e);
    return res.status(500).json({ error: 'list_failed' });
  }
});

/* ============================================================================
   NOVOS ENDPOINTS — adicionados sem alterar os existentes
   ========================================================================== */

/**
 * POST /api/payments/reconcile
 * Body: { since?: number }  // minutos a varrer (default 1440 = 24h)
 * Varre pagamentos não aprovados recentes, consulta o MP e assenta se aprovado.
 */
router.post('/reconcile', requireAuth, async (req, res) => {
  try {
    const minutes = Math.max(5, Number(req.body?.since ?? req.body?.minutes ?? 1440));
    const result = await _reconcilePendingPaymentsCore(minutes);
    return res.json(result);
  } catch (e) {
    console.error('[reconcile] fatal error:', e);
    return res.status(500).json({ error: 'reconcile_failed' });
  }
});

/**
 * POST /api/payments/webhook/replay
 * Body: { id: string }  // paymentId
 * Reexecuta a lógica do webhook para um pagamento específico.
 */
router.post('/webhook/replay', requireAuth, async (req, res) => {
  try {
    const paymentId = req.body?.id || req.body?.paymentId;
    if (!paymentId) return res.status(400).json({ error: 'missing_id' });

    const resp = await mpPayment.get({ id: String(paymentId) });
    const body = resp?.body || resp;

    const id = String(body?.id || paymentId);
    const rawStatus = body?.status || body?.payment_status || 'pending';
    const approvedNow = isApprovedPaymentStatus(rawStatus);

    if (approvedNow) {
      const pr = await query(`SELECT draw_id, numbers FROM payments WHERE id = $1`, [id]);
      if (pr.rows.length) {
        const p = pr.rows[0];
        await settleApprovedPayment(id, p.draw_id, p.numbers);
        await creditCouponForApprovedPix(id, 'mercadopago_webhook_replay', {
          runTraceId: req.headers['x-request-id'] ? String(req.headers['x-request-id']) : null,
          numbers: p.numbers,
          draw_id: p.draw_id,
        });
      }
      return res.json({ id, status: 'approved' });
    }

    const normalizedStatus = normalizePaymentStatus(rawStatus);
    await query(
      `UPDATE payments SET status = $2 WHERE id = $1`,
      [id, normalizedStatus]
    );

    return res.json({ id, status: normalizedStatus });
  } catch (e) {
    console.error('[webhook/replay] error:', e);
    return res.status(500).json({ error: 'replay_failed' });
  }
});

export default router;
