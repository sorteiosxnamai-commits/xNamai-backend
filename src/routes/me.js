// src/routes/me.js
import { Router } from 'express';
import { query, ensureUserProfileColumns } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { getTicketPriceCents } from '../services/mainRaffleCompat.js';
import { cleanupExpiredMainReservations } from '../services/mainReservationExpiry.js';
import {
  ensurePromotionalSchema,
  releaseExpiredPromotionalReservations,
} from '../modules/promotional/promotional.repository.js';

const router = Router();

function formatDay(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
  }).format(new Date(value));
}

function paymentLabel(status) {
  const normalized = String(status || "pending").toLowerCase();
  if (["approved", "paid", "pago"].includes(normalized)) return "PAGO";
  if (["pending", "reserved"].includes(normalized)) return "PENDENTE";
  if (normalized === "expired") return "EXPIRADO";
  if (["cancelled", "canceled"].includes(normalized)) return "CANCELADO";
  return "PENDENTE";
}

function statusLabel(status) {
  const normalized = String(status || "reserved").toLowerCase();
  if (["paid", "approved", "pago"].includes(normalized)) return "PAGO";
  if (normalized === "expired") return "EXPIRADO";
  if (["cancelled", "canceled"].includes(normalized)) return "CANCELADO";
  if (normalized === "sorted") return "SORTEADO";
  return "ABERTO";
}

function derivePaymentStatus(row) {
  const paymentStatus = String(row.p_status || "").toLowerCase();
  if (["approved", "paid", "pago"].includes(paymentStatus)) return "paid";

  const reservationPayment = String(row.payment_status || "pending").toLowerCase();
  if (["paid", "approved", "pago"].includes(reservationPayment)) return "paid";

  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
    return "expired";
  }

  return "pending";
}

/**
 * GET /api/me
 * Retorna o usuário logado com perfil completo.
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    await ensureUserProfileColumns();

    const r = await query(
      `
      SELECT
        id,
        name,
        email,
        is_admin,
        cpf,
        phone,
        zip_code,
        street,
        street_number,
        neighborhood,
        city,
        state
      FROM public.users
      WHERE id = $1
      LIMIT 1
      `,
      [userId]
    );

    const u = r.rows[0] || req.user;

    return res.json({
      user: {
        id: u.id,
        name: u.name || null,
        email: u.email || null,
        is_admin: !!u.is_admin,

        cpf: u.cpf || '',
        phone: u.phone || '',
        zip_code: u.zip_code || '',
        street: u.street || '',
        street_number: u.street_number || '',
        neighborhood: u.neighborhood || '',
        city: u.city || '',
        state: u.state || '',
      },
    });
  } catch (e) {
    console.error('[me] error:', e);
    return res.status(500).json({ error: 'me_failed' });
  }
});

/**
 * GET /api/me/reservations
 */
router.get('/reservations', requireAuth, async (req, res) => {
  try {
    console.log("[ACCOUNT_RESERVATIONS]", { userId: req.user?.id });
    await ensurePromotionalSchema();
    await releaseExpiredPromotionalReservations();
    await cleanupExpiredMainReservations();

    const userId = req.user.id;
    const r = await query(
      `
      SELECT
        r.id,
        r.reservation_group_id,
        r.draw_id,
        r.numbers,
        r.status,
        r.payment_status,
        r.amount_cents,
        r.created_at,
        r.expires_at,
        r.payment_id,
        p.status AS p_status
      FROM public.reservations r
      LEFT JOIN public.payments p ON p.id = r.payment_id
      WHERE r.user_id = $1
      ORDER BY r.created_at DESC
      `,
      [userId]
    );

    const normalItems = await Promise.all(
      r.rows.map(async (row) => {
      const paymentStatus = derivePaymentStatus(row);
      const reservationPublicId = row.reservation_group_id
        ? String(row.reservation_group_id)
        : String(row.id);
      const unitPrice = row.draw_id
        ? await getTicketPriceCents(null, row.draw_id)
        : 5500;

      return {
        type: "normal",
        id: reservationPublicId,
        reservation_id: reservationPublicId,
        raw_id: String(row.id),
        draw_id: row.draw_id,
        draw_title: "Sorteio Principal",
        numbers: row.numbers,
        numbers_label: (Array.isArray(row.numbers) ? row.numbers : [])
          .map((n) => String(n).padStart(2, "0"))
          .join(", "),
        amount_cents:
          Number(row.amount_cents || 0) ||
          (Array.isArray(row.numbers) ? row.numbers.length : 0) * unitPrice,
        status: row.status,
        status_label: statusLabel(row.status),
        payment_status: paymentStatus,
        payment_label: paymentLabel(paymentStatus),
        can_pay:
          paymentStatus === "pending" &&
          !["cancelled", "canceled", "expired"].includes(
            String(row.status || "").toLowerCase()
          ),
        created_at: row.created_at,
        day: formatDay(row.created_at),
        expires_at: row.expires_at,
      };
    })
    );

    let promotionalItems = [];
    try {
      const promotional = await query(
        `SELECT
            COALESCE(r.reservation_id::text, r.id::text) AS reservation_id,
            r.draw_id,
            d.title AS draw_title,
            r.numbers,
            r.status,
            r.payment_status,
            COALESCE(NULLIF(r.amount_cents, 0), NULLIF(r.total_cents, 0), cardinality(r.numbers) * COALESCE(d.price_cents, 0), 0)::int AS amount_cents,
            r.created_at,
            r.expires_at,
            r.pix_qr_code,
            r.pix_qr_code_base64,
            r.pix_ticket_url
           FROM public.promotional_reservations r
           JOIN public.promotional_draws d ON d.id = r.draw_id
          WHERE r.user_id = $1
          ORDER BY r.created_at DESC`,
        [userId]
      );

      promotionalItems = promotional.rows.map((row) => ({
        type: "promotional",
        source: "promotional",
        id: row.reservation_id,
        reservation_id: row.reservation_id,
        draw_id: Number(row.draw_id),
        draw_title: row.draw_title || "Sorteio Promocional",
        numbers: Array.isArray(row.numbers) ? row.numbers.map(Number) : [],
        numbers_label: (Array.isArray(row.numbers) ? row.numbers : [])
          .map((n) => String(n).padStart(2, "0"))
          .join(", "),
        amount_cents: Number(row.amount_cents || 0),
        pix_qr_code: row.pix_qr_code || null,
        pix_qr_code_base64: row.pix_qr_code_base64 || null,
        pix_ticket_url: row.pix_ticket_url || null,
        status: row.status || "reserved",
        status_label: statusLabel(row.status),
        payment_status: row.payment_status || "pending",
        payment_label: paymentLabel(row.payment_status),
        can_pay:
          String(row.payment_status || "pending").toLowerCase() === "pending" &&
          ["reserved", "pending", "active"].includes(String(row.status || "reserved").toLowerCase()),
        created_at: row.created_at,
        day: formatDay(row.created_at),
        expires_at: row.expires_at,
      }));
    } catch (promoErr) {
      console.error("[ACCOUNT_RESERVATIONS] promotional error:", {
        message: promoErr?.message,
        code: promoErr?.code,
        detail: promoErr?.detail,
        stack: promoErr?.stack,
      });
    }

    const items = [...normalItems, ...promotionalItems].sort((a, b) => (
      new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
    ));

    res.json({ success: true, ok: true, items, reservations: items });
  } catch (e) {
    console.error('[ACCOUNT_RESERVATIONS] error:', {
      message: e?.message,
      code: e?.code,
      detail: e?.detail,
      stack: e?.stack,
    });
    res.status(500).json({ success: false, ok: false, error: 'me_list_failed' });
  }
});

/**
 * GET /api/me/purchase-history
 * Histórico de compras pagas/aprovadas (principal + promocional).
 */
router.get('/purchase-history', requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user?.id);

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(401).json({
        ok: false,
        error: 'unauthorized',
      });
    }

    const mainResult = await query(
      `
      SELECT
        p.id::text AS id,
        'main'::text AS type,
        'Principal'::text AS type_label,
        p.draw_id::int AS draw_id,
        COALESCE(
          NULLIF(d.title, ''),
          NULLIF(d.prize, ''),
          'Sorteio Principal #' || p.draw_id::text
        ) AS draw_title,
        COALESCE(p.numbers, '{}'::int[]) AS numbers,
        COALESCE(p.amount_cents, 0)::int AS amount_cents,
        LOWER(COALESCE(p.status, 'paid')) AS status,
        p.paid_at,
        COALESCE(p.paid_at, p.created_at) AS purchased_at,
        COALESCE(d.status, '') AS draw_status
      FROM public.payments p
      LEFT JOIN public.draws d
        ON d.id = p.draw_id
      WHERE p.user_id = $1
        AND LOWER(COALESCE(p.status, '')) IN ('approved', 'paid', 'pago', 'sold')
      `,
      [userId]
    );

    let promotionalRows = [];

    try {
      const promotionalResult = await query(
        `
        SELECT
          COALESCE(r.payment_id, r.reservation_id::text, r.id::text) AS id,
          'promotional'::text AS type,
          'Promocional'::text AS type_label,
          r.draw_id::int AS draw_id,
          COALESCE(
            NULLIF(d.title, ''),
            NULLIF(d.prize, ''),
            'Sorteio Promocional #' || r.draw_id::text
          ) AS draw_title,
          COALESCE(r.numbers, '{}'::int[]) AS numbers,
          COALESCE(
            NULLIF(r.amount_cents, 0),
            NULLIF(r.total_cents, 0),
            cardinality(COALESCE(r.numbers, '{}'::int[])) * COALESCE(NULLIF(r.price_cents, 0), NULLIF(d.price_cents, 0), NULLIF(d.ticket_price_cents, 0), 0),
            0
          )::int AS amount_cents,
          LOWER(COALESCE(r.payment_status, r.status, 'paid')) AS status,
          r.paid_at,
          COALESCE(r.paid_at, r.updated_at, r.created_at) AS purchased_at,
          COALESCE(d.status, '') AS draw_status
        FROM public.promotional_reservations r
        LEFT JOIN public.promotional_draws d
          ON d.id = r.draw_id
        WHERE r.user_id = $1
          AND (
            LOWER(COALESCE(r.payment_status, '')) IN ('approved', 'paid', 'pago', 'sold')
            OR LOWER(COALESCE(r.status, '')) IN ('approved', 'paid', 'pago', 'sold')
          )
        `,
        [userId]
      );

      promotionalRows = promotionalResult.rows || [];
    } catch (promoError) {
      console.error('[me/purchase-history] promotional query error:', {
        message: promoError?.message,
        code: promoError?.code,
        detail: promoError?.detail,
      });

      promotionalRows = [];
    }

    const formatMoney = (cents) => {
      const value = (Number(cents) || 0) / 100;
      return value.toLocaleString('pt-BR', {
        style: 'currency',
        currency: 'BRL',
      });
    };

    const normalizeNumbers = (numbers) => {
      if (!Array.isArray(numbers)) return [];

      return numbers
        .map((number) => Number(number))
        .filter((number) => Number.isFinite(number))
        .sort((a, b) => a - b);
    };

    const items = [...(mainResult.rows || []), ...promotionalRows]
      .map((row) => {
        const numbers = normalizeNumbers(row.numbers);

        return {
          id: row.id,
          type: row.type,
          type_label: row.type_label,
          draw_id: Number(row.draw_id),
          draw_title: row.draw_title || (row.type === 'promotional' ? 'Sorteio Promocional' : 'Sorteio Principal'),
          numbers,
          numbers_label: numbers.map((number) => String(number).padStart(2, '0')).join(', '),
          amount_cents: Number(row.amount_cents || 0),
          amount_label: formatMoney(row.amount_cents),
          status: row.status || 'paid',
          paid_at: row.paid_at || null,
          purchased_at: row.purchased_at || row.paid_at || null,
          draw_status: row.draw_status || null,
        };
      })
      .sort((a, b) => {
        const timeA = new Date(a.purchased_at || 0).getTime();
        const timeB = new Date(b.purchased_at || 0).getTime();
        return timeB - timeA;
      });

    return res.json({
      ok: true,
      last_purchase: items[0] || null,
      items,
    });
  } catch (error) {
    console.error('[me/purchase-history] error:', {
      message: error?.message,
      code: error?.code,
      detail: error?.detail,
      stack: error?.stack,
    });

    return res.status(500).json({
      ok: false,
      error: 'purchase_history_failed',
    });
  }
});

/**
 * PATCH /api/me/profile
 * Atualiza CPF, telefone e endereço do usuário logado.
 */
router.patch('/profile', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;

    if (!userId) {
      return res.status(401).json({
        ok: false,
        code: 'unauthorized',
        message: 'Faça login para atualizar seus dados.',
      });
    }

    const cleanDigits = (value) => String(value || '').replace(/\D/g, '');

    const cpf = cleanDigits(req.body.cpf);
    const phone = cleanDigits(req.body.phone);
    const zipCode = cleanDigits(req.body.zip_code);

    if (cpf && cpf.length !== 11) {
      return res.status(400).json({
        ok: false,
        code: 'invalid_cpf',
        message: 'CPF inválido.',
      });
    }

    if (phone && phone.length < 10) {
      return res.status(400).json({
        ok: false,
        code: 'invalid_phone',
        message: 'Telefone inválido.',
      });
    }

    if (zipCode && zipCode.length !== 8) {
      return res.status(400).json({
        ok: false,
        code: 'invalid_zip_code',
        message: 'CEP inválido.',
      });
    }

    await ensureUserProfileColumns();

    const result = await query(
      `
      UPDATE public.users
         SET cpf = COALESCE(NULLIF($1, ''), cpf),
             phone = COALESCE(NULLIF($2, ''), phone),
             zip_code = COALESCE(NULLIF($3, ''), zip_code),
             street = COALESCE(NULLIF($4, ''), street),
             street_number = COALESCE(NULLIF($5, ''), street_number),
             neighborhood = COALESCE(NULLIF($6, ''), neighborhood),
             city = COALESCE(NULLIF($7, ''), city),
             state = COALESCE(NULLIF(UPPER($8), ''), state)
       WHERE id = $9
       RETURNING
         id,
         name,
         email,
         phone,
         zip_code,
         street,
         street_number,
         neighborhood,
         city,
         state
      `,
      [
        cpf,
        phone,
        zipCode,
        req.body.street || '',
        req.body.street_number || '',
        req.body.neighborhood || '',
        req.body.city || '',
        req.body.state || '',
        userId,
      ]
    );

    return res.json({
      ok: true,
      user: result.rows[0],
    });
  } catch (err) {
    console.error('[ME_PROFILE_UPDATE_ERROR]', {
      message: err?.message,
      code: err?.code,
      detail: err?.detail,
    });

    return res.status(500).json({
      ok: false,
      code: 'profile_update_failed',
      message: 'Não foi possível atualizar seus dados.',
    });
  }
});

export default router;
