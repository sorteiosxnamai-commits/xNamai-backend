// src/routes/me.js
import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { getTicketPriceCents } from '../services/config.js';

const router = Router();

async function ensureReservationPaymentColumns() {
  await query(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending'`);
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
    await ensureReservationPaymentColumns();
    const userId = req.user.id;
    const r = await query(
      `select id, draw_id, numbers, status, payment_status, created_at, expires_at
         from reservations
        where user_id = $1
        order by created_at desc`,
      [userId]
    );

    const priceCents = await getTicketPriceCents();
    const reservations = r.rows.map(row => ({
      type: "main",
      id: row.id,
      reservation_id: row.id,
      draw_id: row.draw_id,
      numbers: row.numbers,
      numbers_label: (Array.isArray(row.numbers) ? row.numbers : [])
        .map((n) => String(n).padStart(2, "0"))
        .join(", "),
      amount_cents: (Array.isArray(row.numbers) ? row.numbers.length : 0) * priceCents,
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

    res.json({ reservations });
  } catch (e) {
    console.error('[me/reservations] error:', e);
    res.status(500).json({ error: 'me_list_failed' });
  }
});

export default router;
