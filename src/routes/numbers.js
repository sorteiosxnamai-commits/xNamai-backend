// backend/src/routes/numbers.js
import { Router } from 'express';
import { query } from '../db.js';
import { ensureMainRaffleCompat } from '../services/mainRaffleCompat.js';
import { cleanupExpiredMainReservations } from '../services/mainReservationExpiry.js';

const router = Router();

// gera duas iniciais a partir do nome; se não tiver nome, usa o usuário do e-mail
function initialsFromNameOrEmail(name, email) {
  const nm = String(name || '').trim();
  if (nm) {
    const parts = nm.split(/\s+/).filter(Boolean);
    const first = parts[0]?.[0] || '';
    const last = parts.length > 1 ? parts[parts.length - 1][0] : (parts[0]?.[1] || '');
    return (first + last).toUpperCase();
  }
  const mail = String(email || '').trim();
  const user = mail.includes('@') ? mail.split('@')[0] : mail;
  return user.slice(0, 2).toUpperCase();
}

/**
 * GET /api/numbers
 * - Pega o draw aberto
 * - Garante o schema do sorteio principal
 * - Expira reservas e números vencidos
 * - Lê a grade direto de public.numbers (fonte da verdade)
 * - Marca como "sold" os números com pagamento aprovado em payments
 *   (inclui owner_initials)
 * - Marca como "reserved" os números com reserved_until > now em public.numbers
 * - Retorna o status final para cada número
 */
router.get('/', async (_req, res) => {
  try {
    const dr = await query(
      `SELECT id FROM draws WHERE status = 'open' ORDER BY id DESC LIMIT 1`
    );
    if (!dr.rows.length) return res.json({ drawId: null, numbers: [] });
    const drawId = dr.rows[0].id;

    await ensureMainRaffleCompat();
    await cleanupExpiredMainReservations(null, drawId);

    const pays = await query(
      `
      SELECT
        num.n::int       AS n,
        u.name           AS owner_name,
        u.email          AS owner_email
      FROM payments p
      LEFT JOIN users u ON u.id = p.user_id
      CROSS JOIN LATERAL unnest(p.numbers) AS num(n)
      WHERE p.draw_id = $1
        AND lower(p.status) IN ('approved','paid','pago')
      `,
      [drawId]
    );

    const initialsByN = new Map();
    for (const row of pays.rows || []) {
      const num = Number(row.n);
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
        user_id
      FROM public.numbers
      WHERE draw_id = $1
      ORDER BY COALESCE(n::int, number) ASC
      `,
      [drawId]
    );

    const now = Date.now();

    const numbers = base.rows.map((row) => {
      const num = Number(row.n);
      const status = String(row.status || 'available').toLowerCase();
      const paymentStatus = String(row.payment_status || 'pending').toLowerCase();
      const reservedUntil = row.reserved_until
        ? new Date(row.reserved_until).getTime()
        : null;

      if (
        ['sold', 'paid', 'approved', 'pago', 'vendido', 'aprovado'].includes(status) ||
        ['paid', 'approved', 'pago'].includes(paymentStatus) ||
        initialsByN.has(num)
      ) {
        return {
          n: num,
          status: 'sold',
          owner_initials: initialsByN.get(num) || null,
        };
      }

      if (
        ['reserved', 'pending', 'reservado', 'pendente'].includes(status) &&
        reservedUntil &&
        reservedUntil > now
      ) {
        return {
          n: num,
          status: 'reserved',
        };
      }

      return {
        n: num,
        status: 'available',
      };
    });

    res.json({ drawId, numbers });
  } catch (err) {
    console.error('GET /api/numbers failed', err);
    res.status(500).json({ error: 'failed_to_list_numbers' });
  }
});

export default router;
