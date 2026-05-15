import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

/**
 * GET /api/me/draws/:id/board
 * Retorna o tabuleiro 00..99 com:
 * - isMine: números do usuário logado (payments aprovados/pagos)
 * - state: available | reserved | taken
 * - isWinner: número sorteado
 * Também retorna product_name/product_link e o nome do vencedor (se houver).
 */
router.get("/:id/board", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    const drawId = Number(req.params.id);
    if (!Number.isInteger(drawId) || drawId <= 0) {
      return res.status(400).json({ error: "bad_draw_id" });
    }

    await query(`ALTER TABLE public.numbers ADD COLUMN IF NOT EXISTS n INTEGER`);
    await query(`ALTER TABLE public.numbers ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'available'`);
    await query(`ALTER TABLE public.numbers ADD COLUMN IF NOT EXISTS reservation_id TEXT`);
    await query(`ALTER TABLE public.numbers ADD COLUMN IF NOT EXISTS user_id BIGINT`);
    await query(`ALTER TABLE public.numbers ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending'`);
    await query(`ALTER TABLE public.numbers ADD COLUMN IF NOT EXISTS reserved_until TIMESTAMPTZ NULL`);
    await query(`ALTER TABLE public.numbers ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMPTZ NULL`);
    await query(`ALTER TABLE public.numbers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);

    await query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'numbers'
             AND column_name = 'number'
        ) THEN
          EXECUTE '
            UPDATE public.numbers
               SET n = number::INTEGER
             WHERE n IS NULL
               AND number IS NOT NULL
          ';
        END IF;
      END $$;
    `);

    await query(
      `UPDATE public.reservations
          SET status = 'expired',
              payment_status = 'expired',
              updated_at = NOW()
        WHERE draw_id = $1
          AND expires_at IS NOT NULL
          AND expires_at <= NOW()
          AND LOWER(COALESCE(status, '')) IN ('active','pending','reserved','reservado','pendente')
          AND LOWER(COALESCE(payment_status, 'pending')) NOT IN ('paid','approved','pago')`,
      [drawId]
    );

    await query(
      `UPDATE public.numbers
          SET status = 'available',
              reservation_id = NULL,
              user_id = NULL,
              payment_status = 'pending',
              reserved_until = NULL,
              reserved_at = NULL,
              updated_at = NOW()
        WHERE draw_id = $1
          AND LOWER(COALESCE(status, '')) IN ('reserved','pending','reservado','pendente')
          AND reserved_until IS NOT NULL
          AND reserved_until <= NOW()
          AND LOWER(COALESCE(payment_status, 'pending')) NOT IN ('paid','approved','pago')`,
      [drawId]
    );

    // dados do sorteio + produto + nome do vencedor
    const d = await query(
      `SELECT d.id,
              d.status,
              d.realized_at,
              d.winner_user_id,
              d.winner_number,
              d.product_name,
              d.product_link,
              u.name AS winner_name
         FROM public.draws d
    LEFT JOIN public.users u
           ON u.id = d.winner_user_id
        WHERE d.id = $1
        LIMIT 1`,
      [drawId]
    );
    if (!d.rows.length) return res.status(404).json({ error: "draw_not_found" });
    const draw = d.rows[0];

    // números comprados por QUALQUER pessoa (indisponíveis)
    const takenR = await query(
      `SELECT unnest(p.numbers)::int AS n
         FROM public.payments p
        WHERE p.draw_id = $1
          AND LOWER(p.status) IN ('approved','paid','pago')`,
      [drawId]
    );

    // reservas ativas/pending/paid (marcamos como "reserved")
    const resvR = await query(
      `SELECT DISTINCT n::int AS n
         FROM (
           SELECT unnest(r.numbers)::int AS n
             FROM public.reservations r
            WHERE r.draw_id = $1
              AND LOWER(COALESCE(r.status, '')) IN ('active','pending','reserved','reservado','pendente')
              AND LOWER(COALESCE(r.payment_status, 'pending')) NOT IN ('paid','approved','pago','expired','cancelled','canceled')
              AND (
                r.expires_at IS NULL
                OR r.expires_at > NOW()
              )

           UNION

           SELECT num.n::int AS n
             FROM public.numbers num
            WHERE num.draw_id = $1
              AND num.n IS NOT NULL
              AND LOWER(COALESCE(num.status, '')) IN ('reserved','pending','reservado','pendente')
              AND LOWER(COALESCE(num.payment_status, 'pending')) NOT IN ('paid','approved','pago','expired','cancelled','canceled')
              AND (
                num.reserved_until IS NULL
                OR num.reserved_until > NOW()
              )
         ) x
        WHERE n BETWEEN 0 AND 99`,
      [drawId]
    );

    // números do usuário logado
    const mineR = await query(
      `SELECT unnest(p.numbers)::int AS n
         FROM public.payments p
        WHERE p.draw_id = $1
          AND p.user_id = $2
          AND LOWER(p.status) IN ('approved','paid','pago')`,
      [drawId, userId]
    );

    const setTaken = new Set((takenR.rows || []).map(r => Number(r.n)));
    const setResv  = new Set((resvR.rows  || []).map(r => Number(r.n)));
    const setMine  = new Set((mineR.rows  || []).map(r => Number(r.n)));
    const winner   = (draw.winner_number ?? null);

    // monta a grade 00..99
    const board = Array.from({ length: 100 }, (_, n) => {
      const isMine   = setMine.has(n);
      const isTaken  = setTaken.has(n);
      const isRes    = setResv.has(n);
      const state =
        isMine ? "taken" :
        isTaken ? "taken" :
        isRes ? "reserved" : "available";
      return {
        n,
        label: String(n).padStart(2, "0"),
        state,                  // available | reserved | taken
        isMine,
        isWinner: winner === n  // usado no UI para estilizar e mostrar o nome
      };
    });

    return res.json({
      draw: {
        id: draw.id,
        status: draw.status,
        realized_at: draw.realized_at,
        winner_number: winner,
        product_name: draw.product_name || null,
        product_link: draw.product_link || null,
        winner_name: draw.winner_name || null,
      },
      my_numbers: Array.from(setMine).sort((a,b)=>a-b),
      board
    });
  } catch (e) {
    console.error("[me/draws/:id/board] error:", e);
    return res.status(500).json({ error: "board_failed" });
  }
});

export default router;
