// src/routes/payments.js
import { Router } from 'express';
import { MercadoPagoConfig, Payment } from 'mercadopago';
import { query, ensureUserProfileColumns } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { ensureMainRaffleCompat, getTicketPriceCents } from '../services/mainRaffleCompat.js';
import {
  isApprovedPaymentStatus,
  settleApprovedMainPayment,
} from '../services/mainPaymentSettlement.js';
import { getBackendPublicUrl } from '../utils/backendUrl.js';
import {
  getMercadoPagoAccessToken,
  getMercadoPagoAuthHeader,
  logMercadoPagoTokenHealth,
} from '../services/mercadoPagoAuth.js';
import {
  buildMercadoPagoPixPayload,
  normalizeCpf,
  parseBrazilPhone,
  maskDocument,
} from '../utils/mercadoPagoPayload.js';

const router = Router();

let mpTokenHealthLogged = false;

function ensureMpTokenHealthLogged() {
  if (mpTokenHealthLogged) return;
  mpTokenHealthLogged = true;
  try {
    logMercadoPagoTokenHealth();
  } catch (e) {
    console.warn('[MP_TOKEN_HEALTH] check failed:', e?.message || e);
  }
}

function getMpPaymentClient() {
  ensureMpTokenHealthLogged();
  const client = new MercadoPagoConfig({
    accessToken: getMercadoPagoAccessToken(),
  });
  return new Payment(client);
}

const PIX_EXP_MIN = Math.max(
  30,
  Number(process.env.PIX_EXP_MIN || process.env.PIX_EXP_MINUTES || 30)
);
const DEFAULT_MAIN_DRAW_NUMBER_COUNT = 100;

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

function normalizePaymentStatus(status) {
  const s = String(status || '').toLowerCase().trim();

  if (['approved', 'paid', 'pago'].includes(s)) return 'approved';
  if (['rejected', 'cancelled', 'canceled', 'refunded', 'charged_back'].includes(s)) return 'rejected';
  if (['pending', 'in_process', 'in_mediation'].includes(s)) return 'pending';

  return s || 'pending';
}

function reservationIsExpired(row) {
  const expiresAt = row?.expires_at
    ? new Date(row.expires_at)
    : row?.created_at
      ? new Date(new Date(row.created_at).getTime() + 30 * 60 * 1000)
      : null;
  return expiresAt ? expiresAt.getTime() < Date.now() : false;
}

/**
 * Fecha o draw se todos os numeros existentes foram vendidos e cria um novo se nao existir outro 'open'.
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
    const totalRes = await query(
      `SELECT COUNT(*)::int AS total
         FROM numbers
        WHERE draw_id = $1`,
      [drawId]
    );
    const totalNumbers = Number(totalRes.rows[0]?.total || 0);

    if (totalNumbers > 0 && sold >= totalNumbers) {
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
        // Popula o sorteio automatico padrao.
        await query(
          `INSERT INTO numbers (draw_id, n, status)
           SELECT $1, gs, 'available'
             FROM generate_series(0, $2::int - 1) AS gs`,
          [newId, DEFAULT_MAIN_DRAW_NUMBER_COUNT]
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
 * Varre pagamentos não aprovados nos últimos N minutos, reconcilia e assenta.
 * Reutilizada pelo endpoint /reconcile e pelo middleware autoReconcile.
 */
async function _repairApprovedUnsettledPayments() {
  const { rows } = await query(
    `
    SELECT DISTINCT p.id::text AS id
      FROM public.payments p
      JOIN public.numbers n ON n.draw_id = p.draw_id
     WHERE LOWER(COALESCE(p.status, '')) IN ('approved', 'paid', 'pago')
       AND COALESCE(n.n::int, n.number) = ANY(COALESCE(p.numbers, '{}'::int[]))
       AND LOWER(COALESCE(n.status, '')) NOT IN ('sold', 'paid', 'approved', 'pago', 'vendido', 'aprovado')
     LIMIT 200
    `
  );

  let repaired = 0;
  for (const { id } of rows) {
    try {
      const settled = await settleApprovedMainPayment(String(id), {
        source: 'repair_approved_unsettled',
      });
      if (settled?.ok) repaired++;
    } catch (e) {
      console.warn('[repair_approved_unsettled] error', id, e?.message);
    }
  }
  if (repaired > 0) {
    console.log('[repair_approved_unsettled] repaired=', repaired);
  }
  return repaired;
}

async function _reconcilePendingPaymentsCore(minutes) {
  await _repairApprovedUnsettledPayments();

  const lookbackMin = Math.max(5, Number(minutes || 1440)); // default 24h
  const { rows } = await query(
    `SELECT id
       FROM public.payments
      WHERE LOWER(COALESCE(status, '')) IN ('pending','in_process','in_mediation')
        AND COALESCE(created_at, NOW()) >= NOW() - ($1::int || ' minutes')::interval
        AND COALESCE(provider, 'mercadopago') = 'mercadopago'
      ORDER BY created_at DESC
      LIMIT 50`,
    [lookbackMin]
  );

  const TERMINAL_MP = new Set(['cancelled', 'canceled', 'rejected', 'refunded', 'charged_back']);

  let scanned = rows.length, updated = 0, approved = 0, failed = 0;

  async function markRejected(paymentId, statusDetail) {
    await query(
      `UPDATE public.payments
          SET status = 'rejected',
              status_detail = $2,
              updated_at = NOW()
        WHERE id = $1`,
      [paymentId, statusDetail || 'mp_payment_not_found']
    );
    updated++;
  }

  for (const { id } of rows) {
    try {
      const resp = await getMpPaymentClient().get({ id: String(id) });
      const body = resp?.body || resp;
      const rawStatus = String(body?.status || body?.payment_status || 'pending').toLowerCase();
      const approvedNow = isApprovedPaymentStatus(rawStatus);
      const normalizedStatus = approvedNow ? 'approved' : normalizePaymentStatus(rawStatus);

      console.log('[RECONCILE_MP_STATUS]', {
        paymentId: id,
        rawStatus,
        normalizedStatus,
        approvedNow,
      });

      if (approvedNow) {
        const settled = await settleApprovedMainPayment(String(id), {
          source: 'reconcile_sync',
        });
        if (settled?.ok) approved++;
        updated++;
      } else if (TERMINAL_MP.has(rawStatus) || normalizedStatus === 'rejected') {
        await markRejected(id, body?.status_detail || rawStatus);
      } else {
        await query(
          `UPDATE public.payments
              SET status = $2,
                  status_detail = COALESCE($3, status_detail),
                  updated_at = NOW()
            WHERE id = $1`,
          [id, normalizedStatus, body?.status_detail || null]
        );
        updated++;
      }
    } catch (e) {
      failed++;
      const msg = String(e?.message || e || '').toLowerCase();
      const notFound =
        e?.status === 404 ||
        msg.includes('not found') ||
        msg.includes('payment not found') ||
        msg.includes('resource not found');
      if (notFound) {
        await markRejected(id, 'mp_payment_not_found').catch(() => {});
      } else {
        console.warn('[reconcile] error for id', id, e?.message || e);
      }
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

    await ensureMainRaffleCompat();

    // Carrega a reserva + (opcional) usuário (id ou reservation_group_id)
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
         FROM reservations r
    LEFT JOIN users u ON u.id = r.user_id
        WHERE r.id::text = $1::text
           OR r.reservation_group_id::text = $1::text
        LIMIT 1`,
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
    if (reservationIsExpired(rs)) {
      return res.status(400).json({ error: 'reservation_expired' });
    }

    const priceCents = await getTicketPriceCents(null, rs.draw_id);
    const numbers = Array.isArray(rs.numbers) ? rs.numbers.map(Number) : [];
    const amountCents = numbers.length * priceCents;
    const amount = Number((amountCents / 100).toFixed(2));

    const notificationUrl = `${getBackendPublicUrl(req)}/api/payments/webhook`;
    console.log('[MP_NOTIFICATION_URL]', { notificationUrl });
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

    const idempotencyKey = `xnamai-main-${reservationId}`;

    const mpResponse = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        Authorization: getMercadoPagoAuthHeader(),
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
    const createdStatus = normalizePaymentStatus(status);

    const externalReference = String(reservationId);
    await query(
      `INSERT INTO payments (
         id, user_id, draw_id, numbers, amount_cents, status,
         provider, provider_payment_id, external_reference,
         qr_code, qr_code_base64, pix_qr_code, pix_qr_code_base64,
         pix_ticket_url, pix_copy_paste, raw, updated_at
       )
       VALUES (
         $1,$2,$3,$4,$5,$6,'mercadopago',$1,$7,
         $8,$9,$8,$9,$10,$8,$11::jsonb,NOW()
       )
       ON CONFLICT (id) DO UPDATE
         SET status = EXCLUDED.status,
             provider = 'mercadopago',
             provider_payment_id = COALESCE(EXCLUDED.provider_payment_id, payments.provider_payment_id),
             external_reference = COALESCE(EXCLUDED.external_reference, payments.external_reference),
             amount_cents = COALESCE(EXCLUDED.amount_cents, payments.amount_cents),
             qr_code = COALESCE(EXCLUDED.qr_code, payments.qr_code),
             qr_code_base64 = COALESCE(EXCLUDED.qr_code_base64, payments.qr_code_base64),
             pix_qr_code = COALESCE(EXCLUDED.pix_qr_code, payments.pix_qr_code),
             pix_qr_code_base64 = COALESCE(EXCLUDED.pix_qr_code_base64, payments.pix_qr_code_base64),
             pix_ticket_url = COALESCE(EXCLUDED.pix_ticket_url, payments.pix_ticket_url),
             pix_copy_paste = COALESCE(EXCLUDED.pix_copy_paste, payments.pix_copy_paste),
             raw = COALESCE(EXCLUDED.raw, payments.raw),
             updated_at = NOW()`,
      [
        String(id),
        userId,
        drawId,
        numbers,
        amountCents,
        createdStatus,
        externalReference,
        qr_code || null,
        qr_code_base64 || null,
        ticket_url || null,
        JSON.stringify(body),
      ]
    );

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
        String(id),
        isApprovedPaymentStatus(status) ? 'paid' : 'pending',
        amountCents,
        qr_code || null,
        qr_code_base64 || null,
        ticket_url || null,
      ]
    );

    console.log('[MP_PIX_CREATED]', {
      paymentId: String(id),
      reservationId,
      drawId,
      numbers,
      status: createdStatus,
      notification_url: notificationUrl,
    });

    if (isApprovedPaymentStatus(status)) {
      await settleApprovedMainPayment(String(id), {
        source: 'mercadopago_create_immediate_approved',
        runTraceId: `mp.create.approved#${String(id)}`,
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
    const paymentId = String(req.params.id);
    const resp = await getMpPaymentClient().get({ id: paymentId });
    const body = resp?.body || resp;

    const rawStatus = body?.status || body?.payment_status || 'pending';
    const approvedNow = isApprovedPaymentStatus(rawStatus);
    const normalizedStatus = approvedNow ? 'approved' : normalizePaymentStatus(rawStatus);

    await query(
      `UPDATE payments
          SET status = $2,
              updated_at = NOW()
        WHERE id::text = $1::text`,
      [paymentId, normalizedStatus]
    );

    let settlement = null;
    if (approvedNow) {
      settlement = await settleApprovedMainPayment(paymentId, {
        source: 'mercadopago_status_check',
        runTraceId: `mp.status#${paymentId}`,
        mpPayment: body,
      });
    }

    const pr = await query(
      `SELECT amount_cents, coupon_credited, coupon_amount_cents, coupon_cashback_percent, status
         FROM payments
        WHERE id = $1`,
      [paymentId]
    );
    const row = pr.rows[0] || {};

    return res.json({
      ok: true,
      id: paymentId,
      status: normalizedStatus,
      amount_cents: row.amount_cents ?? null,
      coupon_credited: row.coupon_credited ?? false,
      coupon_amount_cents: row.coupon_amount_cents ?? settlement?.creditResult?.delta_cents ?? null,
      coupon_cashback_percent: row.coupon_cashback_percent ?? null,
      settlement: settlement?.ok ? { ok: true, numbers: settlement.numbers } : settlement,
    });
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
    const paymentId =
      req.body?.data?.id ||
      req.body?.id ||
      req.query?.id ||
      req.query?.['data.id'];
    const type = req.body?.type || req.query?.type;

    if (type && type !== 'payment') return res.sendStatus(200);
    if (!paymentId) return res.sendStatus(200);

    const resp = await getMpPaymentClient().get({ id: String(paymentId) });
    const body = resp?.body || resp;

    const id = String(body.id || paymentId);
    const rawStatus = body?.status || body?.payment_status || 'pending';
    const approvedNow = isApprovedPaymentStatus(rawStatus);

    console.log('[MP_WEBHOOK_RECEIVED]', {
      paymentId: id,
      rawStatus,
      external_reference: body?.external_reference || null,
    });

    await query(
      `UPDATE payments
          SET status = $2,
              updated_at = NOW()
        WHERE id = $1`,
      [id, approvedNow ? 'approved' : normalizePaymentStatus(rawStatus)]
    );

    if (approvedNow) {
      await settleApprovedMainPayment(id, {
        source: 'mercadopago_webhook',
        runTraceId: req.headers['x-request-id'] ? String(req.headers['x-request-id']) : null,
        mpPayment: body,
      });
    }

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

    const resp = await getMpPaymentClient().get({ id: String(paymentId) });
    const body = resp?.body || resp;

    const id = String(body?.id || paymentId);
    const rawStatus = body?.status || body?.payment_status || 'pending';
    const approvedNow = isApprovedPaymentStatus(rawStatus);

    const normalizedStatus = approvedNow ? 'approved' : normalizePaymentStatus(rawStatus);
    await query(
      `UPDATE payments SET status = $2 WHERE id = $1`,
      [id, normalizedStatus]
    );

    let settlement = null;
    if (approvedNow) {
      settlement = await settleApprovedMainPayment(id, {
        source: 'mercadopago_webhook_replay',
        runTraceId: req.headers['x-request-id'] ? String(req.headers['x-request-id']) : null,
        mpPayment: body,
      });
    }

    const pr = await query(
      `SELECT amount_cents, coupon_amount_cents, coupon_cashback_percent
         FROM payments WHERE id = $1`,
      [id]
    );
    const row = pr.rows[0] || {};

    return res.json({
      id,
      status: normalizedStatus,
      settlement,
      amount_cents: row.amount_cents ?? null,
      coupon_amount_cents: row.coupon_amount_cents ?? null,
      coupon_cashback_percent: row.coupon_cashback_percent ?? null,
    });
  } catch (e) {
    console.error('[webhook/replay] error:', e);
    return res.status(500).json({ error: 'replay_failed' });
  }
});

export default router;
