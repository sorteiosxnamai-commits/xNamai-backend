// src/routes/me.js
import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { getTicketPriceCents } from '../services/config.js';
import {
  ensurePromotionalSchema,
  releaseExpiredPromotionalReservations,
} from '../modules/promotional/promotional.repository.js';

const router = Router();

async function ensureReservationPaymentColumns() {
  await query(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending'`);
  await query(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS amount_cents INTEGER`);
  await query(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS payment_id TEXT NULL`);
  await query(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS pix_qr_code TEXT NULL`);
  await query(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS pix_qr_code_base64 TEXT NULL`);
  await query(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS pix_copy_paste TEXT NULL`);
  await query(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);
}

function formatDay(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
  }).format(new Date(value));
}

function paymentLabel(status) {
  const normalized = String(status || "pending").toLowerCase();
  if (normalized === "paid") return "PAGO";
  if (normalized === "cancelled") return "CANCELADO";
  if (normalized === "expired") return "EXPIRADO";
  return "PENDENTE";
}

function statusLabel(status) {
  const normalized = String(status || "reserved").toLowerCase();
  if (normalized === "sorted") return "SORTEADO";
  if (normalized === "cancelled") return "CANCELADO";
  if (normalized === "paid") return "PAGO";
  return "ABERTO";
}

/**
 * GET /api/me
 * Retorna o usuário logado (id, name, email, is_admin).
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    // busca no banco pra garantir dados atualizados
    const r = await query(
      'select id, name, email, is_admin from users where id = $1',
      [userId]
    );
    const u = r.rows[0] || req.user;

    return res.json({
      user: {
        id: u.id,
        name: u.name || null,
        email: u.email || null,
        is_admin: !!u.is_admin,
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
    await ensureReservationPaymentColumns();
    await ensurePromotionalSchema();
    await releaseExpiredPromotionalReservations();
    const userId = req.user.id;
    const r = await query(
      `select id, draw_id, numbers, status, payment_status, amount_cents, created_at, expires_at
         from reservations
        where user_id = $1
        order by created_at desc`,
      [userId]
    );

    const priceCents = await getTicketPriceCents();
    const normalItems = r.rows.map(row => ({
      type: "normal",
      id: row.id,
      reservation_id: row.id,
      draw_id: row.draw_id,
      draw_title: "Sorteio Principal",
      numbers: row.numbers,
      numbers_label: (Array.isArray(row.numbers) ? row.numbers : [])
        .map((n) => String(n).padStart(2, "0"))
        .join(", "),
      amount_cents: Number(row.amount_cents || 0) || (Array.isArray(row.numbers) ? row.numbers.length : 0) * priceCents,
      status: row.status,
      status_label: statusLabel(row.status),
      payment_status: row.payment_status || "pending",
      payment_label: paymentLabel(row.payment_status),
      can_pay:
        String(row.payment_status || "pending").toLowerCase() === "pending" &&
        !["cancelled", "expired"].includes(String(row.status || "").toLowerCase()),
      created_at: row.created_at,
      day: formatDay(row.created_at),
      expires_at: row.expires_at
    }));

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

export default router;
