// src/routes/admin_clients.js
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

const router = Router();

/**
 * GET /api/admin/clients/active
 * Lista SOMENTE clientes com saldo manual > 0.
 * O saldo considerado é EXCLUSIVAMENTE o campo `coupon_value_cents`.
 * (Se a coluna não existir, faz fallback para `coupon_cents`.)
 */
router.get("/active", requireAuth, requireAdmin, async (_req, res) => {
  async function run(col /* 'coupon_value_cents' | 'coupon_cents' */) {
    const r = await query(
      `
      WITH pays AS (
        SELECT
          p.user_id,
          COUNT(*) FILTER (WHERE lower(trim(coalesce(p.status,''))) = 'approved') AS compras,
          MAX(COALESCE(p.paid_at, p.created_at)) FILTER (WHERE lower(trim(coalesce(p.status,''))) = 'approved') AS last_buy
        FROM public.payments p
        GROUP BY p.user_id
      ),
      wins AS (
        SELECT winner_user_id AS user_id, COUNT(*) AS wins
        FROM public.draws
        WHERE winner_user_id IS NOT NULL
        GROUP BY winner_user_id
      )
      SELECT
        u.id,
        COALESCE(NULLIF(u.name,''), u.email, '-') AS name,
        u.email,
        u.created_at,
        COALESCE(pa.compras, 0)                    AS compras,
        pa.last_buy,
        COALESCE(w.wins, 0)                        AS wins,
        NULLIF(TRIM(u.coupon_code), '')            AS coupon_code,
        COALESCE(u.${col}, 0)::bigint              AS coupon_value_cents,

        -- validade: se não houver compra, conta 6 meses a partir de agora
        (COALESCE(pa.last_buy, NOW()) + INTERVAL '6 months')::date AS expires_at,
        ((COALESCE(pa.last_buy, NOW()) + INTERVAL '6 months')::date - NOW()::date) AS days_to_expire
      FROM public.users u
      LEFT JOIN pays pa ON pa.user_id = u.id
      LEFT JOIN wins w  ON w.user_id = u.id
      WHERE COALESCE(u.${col}, 0) > 0  -- SOMENTE quem tem saldo manual > 0
      ORDER BY expires_at ASC, coupon_value_cents DESC
      `
    );

    const items = (r.rows || []).map((row) => {
      const cents = Number(row.coupon_value_cents || 0);
      return {
        user_id: row.id,
        name: row.name,
        email: row.email,
        created_at: row.created_at,

        purchases_count: Number(row.compras || 0),
        last_buy: row.last_buy,
        wins: Number(row.wins || 0),

        coupon_code: row.coupon_code || null,
        coupon_value_cents: cents,
        coupon_value_brl: +(cents / 100).toFixed(2),

        // Compat com o front atual (coluna "VALOR TOTAL INVESTIDO"):
        total_brl: +(cents / 100).toFixed(2),

        expires_at: row.expires_at,
        days_to_expire: Math.max(0, Number(row.days_to_expire) || 0),
      };
    });

    // garantia extra: não devolver ninguém com 0
    return items.filter((i) => (i.coupon_value_cents || 0) > 0);
  }

  try {
    // tenta com coupon_value_cents; se a coluna não existir, usa coupon_cents
    try {
      const items = await run("coupon_value_cents");
      return res.json({ clients: items });
    } catch (e1) {
      if (e1?.code !== "42703") throw e1;
      const items = await run("coupon_cents");
      return res.json({ clients: items });
    }
  } catch (e) {
    console.error("[admin/clients/active] error:", e?.code, e?.message);
    return res.status(500).json({ error: "list_failed" });
  }
});

/**
 * GET /api/admin/clients/purchase-history
 * Histórico geral de compras pagas/aprovadas para o painel admin.
 * Une Sorteio Principal + Sorteios Promocionais sem alterar o fluxo existente.
 */
router.get("/purchase-history", requireAuth, requireAdmin, async (req, res) => {
  try {
    const search = String(req.query.q || "").trim();
    const typeFilter = String(req.query.type || "all").trim().toLowerCase();

    const limit = Math.min(
      500,
      Math.max(1, Number.parseInt(req.query.limit || "250", 10) || 250)
    );

    const offset = Math.max(
      0,
      Number.parseInt(req.query.offset || "0", 10) || 0
    );

    const hasSearch = search.length > 0;
    const like = `%${search}%`;

    const formatMoney = (cents) => {
      const value = (Number(cents) || 0) / 100;

      return value.toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL",
      });
    };

    const normalizeNumbers = (numbers) => {
      if (!Array.isArray(numbers)) return [];

      return numbers
        .map((number) => Number(number))
        .filter((number) => Number.isFinite(number))
        .sort((a, b) => a - b);
    };

    let mainRows = [];

    if (typeFilter === "all" || typeFilter === "main" || typeFilter === "principal") {
      const params = hasSearch ? [like] : [];

      const mainResult = await query(
        `
        SELECT
          p.id::text AS id,
          'main'::text AS type,
          'Principal'::text AS type_label,
          p.user_id::int AS user_id,
          COALESCE(NULLIF(u.name, ''), u.email, 'Cliente #' || p.user_id::text) AS customer_name,
          u.email AS customer_email,
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
          COALESCE(p.paid_at, p.created_at) AS purchased_at
        FROM public.payments p
        LEFT JOIN public.users u
          ON u.id = p.user_id
        LEFT JOIN public.draws d
          ON d.id = p.draw_id
        WHERE LOWER(TRIM(COALESCE(p.status, ''))) IN ('approved', 'paid', 'pago', 'sold', 'vendido', 'aprovado')
        ${
          hasSearch
            ? `
              AND (
                COALESCE(u.name, '') ILIKE $1
                OR COALESCE(u.email, '') ILIKE $1
                OR CAST(u.id AS text) ILIKE $1
                OR CAST(p.user_id AS text) ILIKE $1
                OR CAST(p.draw_id AS text) ILIKE $1
                OR COALESCE(d.title, '') ILIKE $1
                OR COALESCE(d.prize, '') ILIKE $1
              )
            `
            : ""
        }
        `,
        params
      );

      mainRows = mainResult.rows || [];
    }

    let promotionalRows = [];

    if (typeFilter === "all" || typeFilter === "promotional" || typeFilter === "promocional") {
      try {
        const params = hasSearch ? [like] : [];

        const promotionalResult = await query(
          `
          SELECT
            COALESCE(r.payment_id, r.reservation_id::text, r.id::text) AS id,
            'promotional'::text AS type,
            'Promocional'::text AS type_label,
            r.user_id::int AS user_id,
            COALESCE(
              NULLIF(u.name, ''),
              NULLIF(r.buyer_name, ''),
              u.email,
              NULLIF(r.buyer_email, ''),
              'Cliente sem cadastro'
            ) AS customer_name,
            COALESCE(u.email, r.buyer_email) AS customer_email,
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
            COALESCE(r.paid_at, r.updated_at, r.created_at) AS purchased_at
          FROM public.promotional_reservations r
          LEFT JOIN public.users u
            ON u.id = r.user_id
          LEFT JOIN public.promotional_draws d
            ON d.id = r.draw_id
          WHERE (
            LOWER(TRIM(COALESCE(r.payment_status, ''))) IN ('approved', 'paid', 'pago', 'sold', 'vendido', 'aprovado')
            OR LOWER(TRIM(COALESCE(r.status, ''))) IN ('approved', 'paid', 'pago', 'sold', 'vendido', 'aprovado')
          )
          ${
            hasSearch
              ? `
                AND (
                  COALESCE(u.name, '') ILIKE $1
                  OR COALESCE(u.email, '') ILIKE $1
                  OR COALESCE(r.buyer_name, '') ILIKE $1
                  OR COALESCE(r.buyer_email, '') ILIKE $1
                  OR CAST(r.user_id AS text) ILIKE $1
                  OR CAST(r.draw_id AS text) ILIKE $1
                  OR COALESCE(d.title, '') ILIKE $1
                  OR COALESCE(d.prize, '') ILIKE $1
                )
              `
              : ""
          }
          `,
          params
        );

        promotionalRows = promotionalResult.rows || [];
      } catch (promoError) {
        console.warn("[admin/clients/purchase-history] promotional ignored:", {
          message: promoError?.message,
          code: promoError?.code,
          detail: promoError?.detail,
        });

        promotionalRows = [];
      }
    }

    const items = [...mainRows, ...promotionalRows]
      .map((row) => {
        const numbers = normalizeNumbers(row.numbers);

        return {
          id: row.id,
          type: row.type,
          type_label: row.type_label,
          user_id: row.user_id ? Number(row.user_id) : null,
          customer_name: row.customer_name || "Cliente",
          customer_email: row.customer_email || "",
          draw_id: row.draw_id ? Number(row.draw_id) : null,
          draw_title: row.draw_title || "Sorteio",
          numbers,
          numbers_label: numbers.map((number) => String(number).padStart(2, "0")).join(", "),
          amount_cents: Number(row.amount_cents || 0),
          amount_label: formatMoney(row.amount_cents),
          status: row.status || "paid",
          paid_at: row.paid_at || null,
          purchased_at: row.purchased_at || row.paid_at || null,
        };
      })
      .sort((a, b) => {
        const timeA = new Date(a.purchased_at || 0).getTime();
        const timeB = new Date(b.purchased_at || 0).getTime();
        return timeB - timeA;
      });

    const totalAmountCents = items.reduce(
      (sum, item) => sum + Number(item.amount_cents || 0),
      0
    );

    const uniqueCustomers = new Set(
      items.map((item) => item.user_id || item.customer_email).filter(Boolean)
    );

    const paginatedItems = items.slice(offset, offset + limit);

    return res.json({
      ok: true,
      items: paginatedItems,
      purchases: paginatedItems,
      total: items.length,
      limit,
      offset,
      has_more: offset + paginatedItems.length < items.length,
      summary: {
        total_purchases: items.length,
        total_clients: uniqueCustomers.size,
        total_amount_cents: totalAmountCents,
        total_amount_label: formatMoney(totalAmountCents),
        last_purchase: items[0] || null,
      },
    });
  } catch (error) {
    console.error("[admin/clients/purchase-history] error:", {
      message: error?.message,
      code: error?.code,
      detail: error?.detail,
      stack: error?.stack,
    });

    return res.status(500).json({
      ok: false,
      error: "admin_purchase_history_failed",
    });
  }
});

/**
 * GET /api/admin/clients/:userId/coupon
 * Lê o saldo manual do usuário (preferindo `coupon_value_cents`).
 * Sempre responde 200 com { user_id, code, cents }.
 */
router.get("/:userId/coupon", requireAuth, requireAdmin, async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(400).json({ error: "invalid_user_id" });
  }

  try {
    // tenta coupon_value_cents
    try {
      const r = await query(
        `
        SELECT
          NULLIF(TRIM(u.coupon_code), '')           AS code,
          COALESCE(u.coupon_value_cents, 0)::bigint AS cents
        FROM public.users u
        WHERE u.id = $1
        LIMIT 1
        `,
        [userId]
      );
      if (!r.rowCount) return res.json({ user_id: userId, code: null, cents: 0 });
      const { code, cents } = r.rows[0];
      return res.json({ user_id: userId, code: code || null, cents: Number(cents || 0) });
    } catch (e1) {
      if (e1?.code !== "42703") throw e1;
      // fallback: coupon_cents
      const r2 = await query(
        `
        SELECT
          NULLIF(TRIM(u.coupon_code), '')     AS code,
          COALESCE(u.coupon_cents, 0)::bigint AS cents
        FROM public.users u
        WHERE u.id = $1
        LIMIT 1
        `,
        [userId]
      );
      if (!r2.rowCount) return res.json({ user_id: userId, code: null, cents: 0 });
      const { code, cents } = r2.rows[0];
      return res.json({ user_id: userId, code: code || null, cents: Number(cents || 0) });
    }
  } catch (e) {
    console.error("[admin/clients/:userId/coupon] error:", e?.code, e?.message);
    return res.json({ user_id: userId, code: null, cents: 0 });
  }
});

export default router;
