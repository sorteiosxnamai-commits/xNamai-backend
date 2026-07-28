// backend/src/routes/admin_users.js
// ESM | CRUD de usuários + atribuição de números (isolado deste router)

import express from "express";
import { randomUUID } from "node:crypto";
import { query, getPool } from "../db.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import {
  ensureMainRaffleCompat,
  getTicketPriceCents,
  reservationIdIsUuid,
} from "../services/mainRaffleCompat.js";
import { creditCouponOnApprovedPayment } from "../services/couponBalance.js";

const router = express.Router();
const ADMIN_ASSIGN_RESERVATION_TTL_MINUTES = 30;
const OPEN_DRAW_STATUSES = ["open", "active", "aberto", "ativo"];

router.use(requireAuth, requireAdmin);

/* =============== helpers =============== */

const mapUser = (r) => ({
  id: Number(r.id),
  name: r.name || "",
  email: r.email || "",
  phone: r.phone || r.celular || "",
  is_admin: !!r.is_admin,
  created_at: r.created_at,
  coupon_code: r.coupon_code || "",
  coupon_value_cents: Number(r.coupon_value_cents || 0),
});

const normStr = (v, max = 255) => String(v ?? "").trim().slice(0, max);

async function existingColumns(client, tableName, columns) {
  const result = await client.query(
    `
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
       AND column_name = ANY($2::text[])
    `,
    [tableName, columns]
  );
  return new Set((result.rows || []).map((row) => row.column_name));
}

function addSqlValue(parts, values, column, value, cast = "") {
  values.push(value);
  parts.columns.push(column);
  parts.placeholders.push(`$${values.length}${cast}`);
}

const toInt = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? (n | 0) : def;
};

// Normaliza "numbers": aceita array ou CSV e retorna int[] >= 0 (mantém 00 como 0)
function parseNumbers(input) {
  const normalize = (values) => [...new Set(values)];

  if (Array.isArray(input)) {
    return normalize(input
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n >= 0));
  }
  const s = String(input || "");
  if (!s) return [];
  return normalize(s
    .split(/[,\s;]+/).map((t) => t.trim()).filter(Boolean)
    .map((t) => Number(t))
    .filter((n) => Number.isInteger(n) && n >= 0));
}

export async function creditAdminAssignmentCashback({
  paymentId,
  drawId,
  userId,
  numbers,
  amountCents,
  pgClient,
}) {
  const result = await creditCouponOnApprovedPayment(paymentId, {
    channel: "ADMIN",
    source: "admin_assign",
    runTraceId: `admin.assign#${paymentId}`,
    pgClient,
    meta: {
      provider: "admin_assign",
      draw_id: drawId,
      user_id: userId,
      numbers,
      amount_cents: amountCents,
      cashback_source: "draws.cashback_percent",
    },
  });

  const completed =
    result?.action === "credited" ||
    (
      result?.action === "noop" &&
      ["zero_cashback", "already_in_ledger", "already_credited"].includes(result?.reason)
    );

  if (result?.ok !== true || !completed) {
    const error = new Error(
      `admin_assignment_cashback_failed:${result?.action || "unknown"}:${result?.reason || "unknown"}`
    );
    error.code = "ADMIN_ASSIGN_CASHBACK_FAILED";
    error.couponResult = result || null;
    throw error;
  }

  return result;
}

/* =============== LISTAR (com busca/paginação) =============== */
/**
 * GET /api/admin/users
 * Suporta AMBOS:
 *   - ?q=texto&page=1&pageSize=50
 *   - ?q=texto&limit=50&offset=0
 */
router.get("/", async (req, res, next) => {
  try {
    const { q = "" } = req.query;

    // aceita limit/offset OU page/pageSize
    let limit = toInt(req.query.limit, 0);
    let offset = toInt(req.query.offset, 0);

    if (!(limit > 0)) {
      const page = Math.max(1, toInt(req.query.page, 1));
      const pageSize = Math.min(500, Math.max(1, toInt(req.query.pageSize, 50)));
      limit = pageSize;
      offset = (page - 1) * pageSize;
    } else {
      limit = Math.min(500, Math.max(1, limit));
      offset = Math.max(0, offset);
    }

    const like = `%${String(q).trim()}%`;
    const hasQ = String(q).trim().length > 0;

    const cols = `
      id, name, email, phone, is_admin, created_at, coupon_code, coupon_value_cents
    `;
    const base = `FROM public.users`;
    const where = hasQ
      ? ` WHERE (name ILIKE $3
                OR email ILIKE $3
                OR phone ILIKE $3
                OR coupon_code ILIKE $3
                OR CAST(id AS text) ILIKE $3)`
      : ``;
    const order = ` ORDER BY id DESC`;
    const limoff = ` LIMIT $1 OFFSET $2`;

    const params = hasQ ? [limit, offset, like] : [limit, offset];

    // total para paginação
    const totalSql = `SELECT COUNT(1)::int AS total ${base}${where}`;
    const listSql  = `SELECT ${cols} ${base}${where}${order}${limoff}`;

    const [countR, listR] = await Promise.all([
      query(totalSql, hasQ ? [like] : []),
      query(listSql, params),
    ]);

    const total = Number(countR.rows?.[0]?.total || 0);
    const items = (listR.rows || []).map(mapUser);

    res.json({
      users: items,
      total,
      limit,
      offset,
      page: Math.floor(offset / limit) + 1,
      pageSize: limit,
      hasMore: offset + items.length < total,
    });
  } catch (e) {
    next(e);
  }
});

/* =============== OBTER 1 =============== */
/** GET /api/admin/users/:id */
router.get("/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await query(
      `SELECT id, name, email, phone, is_admin, created_at, coupon_code, coupon_value_cents
         FROM public.users
        WHERE id = $1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    res.json(mapUser(rows[0]));
  } catch (e) {
    next(e);
  }
});

/* =============== CRIAR =============== */
/** POST /api/admin/users
 * body: { name, email, phone, is_admin, coupon_code?, coupon_value_cents? }
 */
router.post("/", async (req, res, next) => {
  try {
    const {
      name = "",
      email = "",
      phone = "",
      is_admin = false,
      coupon_code = "",
      coupon_value_cents = 0,
    } = req.body || {};

    const vals = [
      normStr(name, 255),
      normStr(email, 255),
      normStr(phone, 40),
      !!is_admin,
      normStr(coupon_code, 64),
      toInt(coupon_value_cents, 0),
    ];

    // Senha padrão "newstore" (hash em bcrypt via pgcrypto)
    const DEFAULT_PASSWORD = "newstore";

    const { rows } = await query(
      `INSERT INTO public.users
         (name, email, phone, is_admin, coupon_code, coupon_value_cents, pass_hash)
       VALUES ($1,$2,$3,$4,$5,$6, crypt($7, gen_salt('bf')))
       RETURNING id, name, email, phone, is_admin, created_at, coupon_code, coupon_value_cents`,
      [...vals, DEFAULT_PASSWORD]
    );
    res.status(201).json(mapUser(rows[0]));
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "duplicated" });
    next(e);
  }
});

/* =============== ATUALIZAR =============== */
/** PUT /api/admin/users/:id
 * body: { name?, email?, phone?, is_admin?, coupon_code?, coupon_value_cents? }
 */
router.put("/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { name, email, phone, is_admin, coupon_code, coupon_value_cents } = req.body || {};

    const { rows } = await query(
      `UPDATE public.users
          SET name                 = COALESCE($2, name),
              email                = COALESCE($3, email),
              phone                = COALESCE($4, phone),
              is_admin             = COALESCE($5, is_admin),
              coupon_code          = COALESCE($6, coupon_code),
              coupon_value_cents   = COALESCE($7, coupon_value_cents)
        WHERE id = $1
        RETURNING id, name, email, phone, is_admin, created_at, coupon_code, coupon_value_cents`,
      [
        id,
        name  != null ? normStr(name, 255)  : null,
        email != null ? normStr(email, 255) : null,
        phone != null ? normStr(phone, 40)  : null,
        typeof is_admin === "boolean" ? !!is_admin : null,
        coupon_code         != null ? normStr(coupon_code, 64) : null,
        coupon_value_cents  != null ? toInt(coupon_value_cents, 0) : null,
      ]
    );
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    res.json(mapUser(rows[0]));
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "duplicated" });
    next(e);
  }
});

/* =============== EXCLUIR =============== */
/** DELETE /api/admin/users/:id */
router.delete("/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const r = await query("DELETE FROM public.users WHERE id = $1", [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: "not_found" });
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

/* =============== ATRIBUIR NÚMEROS =============== */
/**
 * POST /api/admin/users/:id/assign-numbers
 * body: { draw_id: number, numbers: number[] | "csv", amount_cents?: number }
 * - Checa conflitos em payments aprovados e reservas ativas
 * - Se ok, cria reserva pending/reserved e marca números como reserved.
 */
router.post("/:id/assign-numbers", async (req, res) => {
  const pool = await getPool();
  const client = await pool.connect();

  try {
    const user_id = Number(req.params.id);
    const draw_id = Number(req.body?.draw_id);
    const numbers = parseNumbers(req.body?.numbers);

    if (!Number.isInteger(user_id) || user_id <= 0) {
      return res.status(400).json({ ok: false, error: "invalid_user_id" });
    }

    if (!Number.isInteger(draw_id) || draw_id <= 0) {
      return res.status(400).json({ ok: false, error: "invalid_draw_id" });
    }

    if (!numbers.length) {
      return res.status(400).json({ ok: false, error: "invalid_numbers" });
    }

    await client.query("BEGIN");
    await ensureMainRaffleCompat(client);

    const userResult = await client.query(
      `
      SELECT id, name, email, phone
        FROM public.users
       WHERE id = $1
       FOR UPDATE
      `,
      [user_id]
    );

    if (!userResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "user_not_found" });
    }

    const drawResult = await client.query(
      `
      WITH current_draw AS (
        SELECT id
          FROM public.draws
         WHERE LOWER(COALESCE(status, '')) = ANY($2::text[])
         ORDER BY id DESC
         LIMIT 1
      )
      SELECT d.id
        FROM public.draws d
        JOIN current_draw cd ON cd.id = d.id
       WHERE d.id = $1
       FOR UPDATE
      `,
      [draw_id, OPEN_DRAW_STATUSES]
    );

    if (!drawResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "draw_not_found" });
    }

    const existingNumbersResult = await client.query(
      `
      SELECT DISTINCT COALESCE(n::int, number) AS number
        FROM public.numbers
       WHERE draw_id = $1
         AND COALESCE(n::int, number) = ANY($2::int[])
       ORDER BY number
      `,
      [draw_id, numbers]
    );

    const existingNumbers = new Set(existingNumbersResult.rows.map((r) => Number(r.number)));
    const missingNumbers = numbers.filter((n) => !existingNumbers.has(n));

    if (missingNumbers.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error: "invalid_numbers",
        invalid_numbers: missingNumbers,
      });
    }

    const ticketPriceCents = await getTicketPriceCents(client, draw_id);
    const amount_cents =
      Number.isFinite(Number(req.body?.amount_cents)) && Number(req.body.amount_cents) > 0
        ? Math.trunc(Number(req.body.amount_cents))
        : numbers.length * ticketPriceCents;

    // Regra de negócio: reserva criada por cliente expira em 30 min, porém
    // número atribuído manualmente pelo admin NÃO expira automaticamente.
    // Mantemos a constante ADMIN_ASSIGN_RESERVATION_TTL_MINUTES apenas para
    // compatibilidade histórica; o valor efetivo aqui é null (sem TTL).
    const expiresAt = null;

    await client.query(
      `
      UPDATE public.reservations
         SET status = 'expired',
             payment_status = 'expired',
             updated_at = NOW()
       WHERE draw_id = $1
         AND expires_at IS NOT NULL
         AND expires_at <= NOW()
         AND LOWER(COALESCE(status, '')) IN ('active','pending','reserved','reservado','pendente')
         AND LOWER(COALESCE(payment_status, 'pending')) NOT IN ('paid','approved','pago')
      `,
      [draw_id]
    );

    await client.query(
      `
      UPDATE public.numbers
         SET status = 'available',
             reservation_id = NULL,
             user_id = NULL,
             payment_status = 'pending',
             reserved_until = NULL,
             reserved_at = NULL,
             payment_id = NULL,
             updated_at = NOW()
       WHERE draw_id = $1
         AND LOWER(COALESCE(status, '')) IN ('reserved','pending','reservado','pendente')
         AND reserved_until IS NOT NULL
         AND reserved_until <= NOW()
         AND LOWER(COALESCE(payment_status, 'pending')) NOT IN ('paid','approved','pago')
      `,
      [draw_id]
    );

    const numberConflicts = await client.query(
      `
      SELECT DISTINCT COALESCE(n::int, number) AS number, status
        FROM public.numbers
       WHERE draw_id = $1
         AND COALESCE(n::int, number) = ANY($2::int[])
         AND (
           LOWER(COALESCE(status, 'available')) IN ('sold','paid','approved','pago','vendido','aprovado','blocked','bloqueado')
           OR (
             LOWER(COALESCE(status, 'available')) IN ('reserved','pending','reservado','pendente')
             AND (reserved_until IS NULL OR reserved_until > NOW())
           )
         )
       ORDER BY number
      `,
      [draw_id, numbers]
    );

    if (numberConflicts.rowCount) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: "numbers_taken",
        conflicts: numberConflicts.rows.map((r) => Number(r.number)),
      });
    }

    const paymentConflicts = await client.query(
      `
      SELECT DISTINCT used.n::int AS number
        FROM public.payments p
        CROSS JOIN LATERAL UNNEST(COALESCE(p.numbers, '{}'::int[])) AS used(n)
       WHERE p.draw_id = $1
         AND used.n = ANY($2::int[])
         AND LOWER(COALESCE(p.status, '')) IN ('approved','paid','pago')
       ORDER BY used.n
      `,
      [draw_id, numbers]
    );

    if (paymentConflicts.rowCount) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: "numbers_paid",
        conflicts: paymentConflicts.rows.map((r) => Number(r.number)),
      });
    }

    const reservationConflicts = await client.query(
      `
      SELECT DISTINCT COALESCE(r.number, used.n)::int AS number
        FROM public.reservations r
        LEFT JOIN LATERAL UNNEST(COALESCE(r.numbers, '{}'::int[])) AS used(n) ON TRUE
       WHERE r.draw_id = $1
         AND COALESCE(r.number, used.n) = ANY($2::int[])
         AND LOWER(COALESCE(r.status, '')) IN ('active','pending','reserved','reservado','pendente')
         AND LOWER(COALESCE(r.payment_status, 'pending')) NOT IN ('paid','approved','pago','expired','cancelled','canceled')
         AND (r.expires_at IS NULL OR r.expires_at > NOW())
       ORDER BY number
      `,
      [draw_id, numbers]
    );

    if (reservationConflicts.rowCount) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: "numbers_reserved",
        conflicts: reservationConflicts.rows.map((r) => Number(r.number)),
      });
    }

    const user = userResult.rows[0];
    const groupId = randomUUID();
    const adminPaymentId = `adminassign:${groupId}`;
    const usesUuidId = await reservationIdIsUuid(client);

    let reservationIdForResponse = groupId;

    if (usesUuidId) {
      await client.query(
        `
        INSERT INTO public.reservations (
          id,
          reservation_group_id,
          user_id,
          draw_id,
          numbers,
          quantity,
          total_amount_cents,
          total_cents,
          amount_cents,
          status,
          payment_status,
          payment_id,
          buyer_name,
          buyer_email,
          buyer_phone,
          expires_at,
          source,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          $1,
          $2,
          $3,
          $4::int[],
          CARDINALITY($4::int[]),
          $5,
          $5,
          $5,
          'reserved',
          'pending',
          NULL,
          $6,
          $7,
          $8,
          $9,
          'admin',
          NOW(),
          NOW()
        )
        `,
        [
          groupId,
          user_id,
          draw_id,
          numbers,
          amount_cents,
          user.name || user.email || "",
          user.email || "",
          user.phone || "",
          expiresAt,
        ]
      );

      const reservedNumbers = await client.query(
        `
        UPDATE public.numbers
           SET status = 'reserved',
               user_id = $3,
               reservation_id = $4,
               payment_status = 'pending',
               reserved_at = NOW(),
               reserved_until = $5,
               payment_id = NULL,
               updated_at = NOW()
         WHERE draw_id = $1
           AND COALESCE(n::int, number) = ANY($2::int[])
        `,
        [draw_id, numbers, user_id, groupId, expiresAt]
      );

      if (reservedNumbers.rowCount !== numbers.length) {
        throw new Error(`assignment_reserve_rowcount_mismatch:${reservedNumbers.rowCount}/${numbers.length}`);
      }
    } else {
      const inserted = await client.query(
        `
        WITH inserted AS (
          INSERT INTO public.reservations (
            reservation_group_id,
            user_id,
            draw_id,
            number,
            numbers,
            quantity,
            price_cents,
            total_amount_cents,
            total_cents,
            amount_cents,
            status,
            payment_status,
            payment_id,
            buyer_name,
            buyer_email,
            buyer_phone,
            expires_at,
            source,
            created_at,
            updated_at
          )
          SELECT
            $1,
            $2,
            $3,
            selected_number,
            $4::int[],
            CARDINALITY($4::int[]),
            $5,
            $6,
            $6,
            $6,
            'reserved',
            'pending',
            NULL,
            $7,
            $8,
            $9,
            $10,
            'admin',
            NOW(),
            NOW()
          FROM UNNEST($4::int[]) AS selected_number
          RETURNING id, number
        )
        UPDATE public.numbers n
           SET status = 'reserved',
               user_id = $2,
               reservation_id = inserted.id,
               payment_status = 'pending',
               reserved_at = NOW(),
               reserved_until = $10,
               payment_id = NULL,
               updated_at = NOW()
          FROM inserted
         WHERE n.draw_id = $3
           AND COALESCE(n.n::int, n.number) = inserted.number
        RETURNING inserted.id, inserted.number
        `,
        [
          groupId,
          user_id,
          draw_id,
          numbers,
          ticketPriceCents,
          amount_cents,
          user.name || user.email || "",
          user.email || "",
          user.phone || "",
          expiresAt,
        ]
      );

      reservationIdForResponse = groupId;

      if (inserted.rowCount !== numbers.length) {
        throw new Error(`assignment_rowcount_mismatch:${inserted.rowCount}/${numbers.length}`);
      }
    }

    const paymentColumns = await existingColumns(client, "payments", [
      "provider",
      "provider_payment_id",
      "external_reference",
      "paid_at",
      "updated_at",
    ]);
    const paymentParts = {
      columns: ["id", "user_id", "draw_id", "numbers", "amount_cents", "status"],
      placeholders: ["$1", "$2", "$3", "$4::int[]", "$5", "$6"],
    };
    const paymentValues = [
      adminPaymentId,
      user_id,
      draw_id,
      numbers,
      amount_cents,
      "approved",
    ];

    if (paymentColumns.has("provider")) {
      addSqlValue(paymentParts, paymentValues, "provider", "admin_assign");
    }
    if (paymentColumns.has("provider_payment_id")) {
      addSqlValue(paymentParts, paymentValues, "provider_payment_id", adminPaymentId);
    }
    if (paymentColumns.has("external_reference")) {
      addSqlValue(paymentParts, paymentValues, "external_reference", groupId);
    }
    if (paymentColumns.has("paid_at")) {
      paymentParts.columns.push("paid_at");
      paymentParts.placeholders.push("NOW()");
    }
    if (paymentColumns.has("updated_at")) {
      paymentParts.columns.push("updated_at");
      paymentParts.placeholders.push("NOW()");
    }

    await client.query(
      `
      INSERT INTO public.payments (
        ${paymentParts.columns.join(", ")}
      )
      VALUES (
        ${paymentParts.placeholders.join(", ")}
      )
      `,
      paymentValues
    );

    const reservationColumns = await existingColumns(client, "reservations", [
      "paid_at",
      "updated_at",
    ]);
    const reservationSet = [
      "status = 'paid'",
      "payment_status = 'paid'",
      "payment_id = $2::text",
      "expires_at = NULL",
    ];
    if (reservationColumns.has("paid_at")) {
      reservationSet.push("paid_at = COALESCE(paid_at, NOW())");
    }
    if (reservationColumns.has("updated_at")) {
      reservationSet.push("updated_at = NOW()");
    }

    const paidReservations = await client.query(
      `
      UPDATE public.reservations
         SET ${reservationSet.join(",\n             ")}
       WHERE reservation_group_id::text = $1::text
          OR id::text = $1::text
      `,
      [groupId, adminPaymentId]
    );

    if (!paidReservations.rowCount) {
      throw new Error("assignment_reservation_paid_mismatch:0");
    }

    const numberColumns = await existingColumns(client, "numbers", [
      "sold_at",
      "updated_at",
    ]);
    const numberSet = [
      "status = 'sold'",
      "payment_status = 'paid'",
      "payment_id = $3::text",
      "user_id = $4",
      "reserved_until = NULL",
      "reservation_id = NULL",
    ];
    if (numberColumns.has("sold_at")) {
      numberSet.push("sold_at = COALESCE(sold_at, NOW())");
    }
    if (numberColumns.has("updated_at")) {
      numberSet.push("updated_at = NOW()");
    }

    const soldNumbers = await client.query(
      `
      UPDATE public.numbers
         SET ${numberSet.join(",\n             ")}
       WHERE draw_id = $1
         AND COALESCE(n::int, number) = ANY($2::int[])
      `,
      [draw_id, numbers, adminPaymentId, user_id]
    );

    if (soldNumbers.rowCount !== numbers.length) {
      throw new Error(`assignment_sold_rowcount_mismatch:${soldNumbers.rowCount}/${numbers.length}`);
    }

    await creditAdminAssignmentCashback({
      paymentId: adminPaymentId,
      drawId: draw_id,
      userId: user_id,
      numbers,
      amountCents: amount_cents,
      pgClient: client,
    });

    await client.query("COMMIT");

    return res.status(201).json({
      ok: true,
      success: true,
      message: "Números atribuídos e marcados como pagos/indisponíveis com sucesso.",
      reservation_id: reservationIdForResponse,
      reservationId: reservationIdForResponse,
      payment_id: adminPaymentId,
      paymentId: adminPaymentId,
      draw_id,
      drawId: draw_id,
      user_id,
      numbers,
      status: "paid",
      payment_status: "paid",
      number_status: "sold",
      expires_at: null,
      expiresAt: null,
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}

    console.error("[ADMIN_ASSIGN_NUMBERS_ERROR]", {
      code: err?.code,
      message: err?.message,
      detail: err?.detail,
      hint: err?.hint,
      stack: err?.stack,
      params: {
        user_id: req.params.id,
        draw_id: req.body?.draw_id,
        numbers: req.body?.numbers,
      },
    });

    return res.status(500).json({
      ok: false,
      error: "assign_numbers_failed",
      message: err?.message || "Falha ao atribuir números.",
      code: err?.code || "ADMIN_ASSIGN_NUMBERS_ERROR",
      detail: err?.detail || null,
      hint: err?.hint || null,
    });
  } finally {
    client.release();
  }
});

export default router;
