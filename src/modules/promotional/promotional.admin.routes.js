import { Router } from "express";
import { getPool, query } from "../../db.js";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import {
  archiveDraw,
  assignNumbersToUser,
  changeDrawStatus,
  createDraw,
  getAdminDraw,
  getNumbers,
  listAdminDraws,
  listParticipants,
  updateDraw,
  updateNumberStatus,
} from "./promotional.service.js";

const router = Router();

router.use(requireAuth, requireAdmin);

function normalizePromotionalAdminStatus(value) {
  const raw = String(value || "inactive").trim().toLowerCase();

  if (["ativo", "active", "publicado", "published", "aberto", "open"].includes(raw)) {
    return "active";
  }

  if (["inativo", "inactive"].includes(raw)) {
    return "inactive";
  }

  if (["rascunho", "draft"].includes(raw)) {
    return "draft";
  }

  if (["fechado", "closed", "encerrado"].includes(raw)) {
    return "closed";
  }

  return "inactive";
}

function parseAdminInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function buildPromotionalAdminDebugError(err, message) {
  return {
    ok: false,
    error: message,
    code: err?.code || "promotional_admin_error",
    debug: {
      message: err?.message || null,
      detail: err?.detail || null,
      hint: err?.hint || null,
      table: err?.table || null,
      column: err?.column || null,
      constraint: err?.constraint || null,
      routine: err?.routine || null,
    },
  };
}

function promotionalAdminDrawSelectSql() {
  return `
    SELECT
      d.*,
      COALESCE(ns.total_numbers, 0)::int AS total_numbers,
      COALESCE(ns.available_numbers, 0)::int AS available_numbers,
      COALESCE(ns.reserved_numbers, 0)::int AS reserved_numbers,
      COALESCE(ns.sold_numbers, 0)::int AS sold_numbers,
      COALESCE(ns.blocked_numbers, 0)::int AS blocked_numbers
    FROM public.promotional_draws d
    LEFT JOIN (
      SELECT
        draw_id,
        COUNT(*)::int AS total_numbers,
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(status, 'available')) = 'available'
        )::int AS available_numbers,
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(status, 'available')) IN ('reserved', 'pending')
        )::int AS reserved_numbers,
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(status, 'available')) IN ('sold', 'paid', 'approved')
        )::int AS sold_numbers,
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(status, 'available')) IN ('blocked', 'unavailable')
        )::int AS blocked_numbers
      FROM public.promotional_numbers
      GROUP BY draw_id
    ) ns ON ns.draw_id = d.id
  `;
}

function handleError(res, err, options = {}) {
  const status = Number(err?.status || err?.statusCode || 500);
  const logTag = options.logTag || "[PROMOTIONAL_ADMIN_ERROR]";

  const debug = {
    code: err?.code || null,
    message: err?.message || null,
    detail: err?.detail || null,
    hint: err?.hint || null,
    constraint: err?.constraint || null,
    table: err?.table || null,
    column: err?.column || null,
    routine: err?.routine || null,
  };

  console.error(logTag, {
    ...debug,
    stack: err?.stack,
  });

  return res.status(status >= 400 && status < 600 ? status : 500).json({
    ok: false,
    error: options.friendlyError || err?.message || "Erro no módulo promocional admin.",
    code: err?.code || "promotional_admin_error",
    debug,
    ...(err?.conflicts && { conflicts: err.conflicts }),
    ...(err?.details && { details: err.details }),
  });
}

router.get("/draws", async (_req, res) => {
  try {
    const result = await query(`
      ${promotionalAdminDrawSelectSql()}
      ORDER BY COALESCE(d.updated_at, d.created_at, NOW()) DESC, d.id DESC
    `);

    return res.json({
      ok: true,
      draws: result.rows,
    });
  } catch (err) {
    console.error("[PROMOTIONAL_ADMIN_DRAWS_LIST_ERROR]", {
      code: err?.code,
      message: err?.message,
      detail: err?.detail,
      hint: err?.hint,
      table: err?.table,
      column: err?.column,
      constraint: err?.constraint,
      routine: err?.routine,
      stack: err?.stack,
    });

    return res.status(500).json(
      buildPromotionalAdminDebugError(err, "Erro ao carregar campanhas promocionais.")
    );
  }
});

router.post("/draws", async (req, res) => {
  const pool = await getPool();
  const client = await pool.connect();

  try {
    const body = req.body || {};

    const title = String(body.title || "").trim();
    const description = String(body.description || "").trim();
    const prize = String(body.prize || "").trim();

    const priceCents = parseAdminInt(
      body.price_cents ?? body.ticket_price_cents ?? body.promotional_price_cents,
      5500
    );

    const numberStart = parseAdminInt(body.number_start, 0);
    const numberEnd = parseAdminInt(body.number_end, 99);
    const maxNumbersPerUser = parseAdminInt(body.max_numbers_per_user, 1);
    const status = normalizePromotionalAdminStatus(body.status);

    const bannerUrl = body.banner_url ? String(body.banner_url).trim() : null;
    const startsAt = body.starts_at || null;
    const endsAt = body.ends_at || null;

    if (!title) {
      return res.status(400).json({
        ok: false,
        error: "Título é obrigatório.",
        code: "missing_title",
      });
    }

    if (!Number.isInteger(priceCents) || priceCents <= 0) {
      return res.status(400).json({
        ok: false,
        error: "Valor por número inválido.",
        code: "invalid_price_cents",
      });
    }

    if (
      !Number.isInteger(numberStart) ||
      !Number.isInteger(numberEnd) ||
      numberStart < 0 ||
      numberEnd < numberStart ||
      numberEnd > 1000
    ) {
      return res.status(400).json({
        ok: false,
        error: "Intervalo de números inválido.",
        code: "invalid_number_range",
      });
    }

    if (!Number.isInteger(maxNumbersPerUser) || maxNumbersPerUser <= 0) {
      return res.status(400).json({
        ok: false,
        error: "Máximo por usuário inválido.",
        code: "invalid_max_numbers_per_user",
      });
    }

    await client.query("BEGIN");

    const insertDraw = await client.query(
      `
      INSERT INTO public.promotional_draws (
        title,
        description,
        prize,
        price_cents,
        ticket_price_cents,
        promotional_price_cents,
        number_start,
        number_end,
        max_numbers_per_user,
        status,
        banner_url,
        starts_at,
        ends_at,
        created_at,
        updated_at
      )
      VALUES (
        $1::text,
        $2::text,
        $3::text,
        $4::int,
        $4::int,
        $4::int,
        $5::int,
        $6::int,
        $7::int,
        $8::text,
        $9::text,
        $10::timestamptz,
        $11::timestamptz,
        NOW(),
        NOW()
      )
      RETURNING *
      `,
      [
        title,
        description,
        prize,
        priceCents,
        numberStart,
        numberEnd,
        maxNumbersPerUser,
        status,
        bannerUrl,
        startsAt,
        endsAt,
      ]
    );

    const draw = insertDraw.rows[0];
    const width = Math.max(2, String(numberEnd).length);

    await client.query(
      `
      WITH generated AS (
        SELECT
          $1::bigint AS draw_id,
          gs::int AS n,
          gs::int AS number_value,
          LPAD(gs::text, $4::int, '0') AS number,
          LPAD(gs::text, $4::int, '0') AS label
        FROM generate_series($2::int, $3::int) AS gs
      )
      INSERT INTO public.promotional_numbers (
        draw_id,
        n,
        number_value,
        number,
        label,
        status,
        payment_status,
        created_at,
        updated_at
      )
      SELECT
        g.draw_id,
        g.n,
        g.number_value,
        g.number,
        g.label,
        'available',
        'pending',
        NOW(),
        NOW()
      FROM generated g
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.promotional_numbers pn
        WHERE pn.draw_id = g.draw_id
          AND COALESCE(
            pn.n,
            pn.number_value,
            NULLIF(regexp_replace(pn.number::text, '\\D', '', 'g'), '')::int
          ) = g.n
      )
      `,
      [draw.id, numberStart, numberEnd, width]
    );

    await client.query("COMMIT");

    const fullDraw = await query(
      `
      ${promotionalAdminDrawSelectSql()}
      WHERE d.id = $1
      LIMIT 1
      `,
      [draw.id]
    );

    return res.status(201).json({
      ok: true,
      draw_id: draw.id,
      draw: fullDraw.rows[0] || draw,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});

    console.error("[PROMOTIONAL_ADMIN_DRAWS_CREATE_ERROR]", {
      code: err?.code,
      message: err?.message,
      detail: err?.detail,
      hint: err?.hint,
      table: err?.table,
      column: err?.column,
      constraint: err?.constraint,
      routine: err?.routine,
      stack: err?.stack,
    });

    return res.status(500).json(
      buildPromotionalAdminDebugError(err, "Erro ao criar campanha promocional.")
    );
  } finally {
    client.release();
  }
});

router.get("/draws/:id/numbers", async (req, res) => {
  try {
    const { numbers } = await getNumbers(req.params.id);
    return res.json({ ok: true, numbers });
  } catch (err) {
    return handleError(res, err, {
      logTag: "[PROMOTIONAL_ADMIN_NUMBERS_ERROR]",
      friendlyError: "Erro ao processar número promocional.",
    });
  }
});

router.patch("/draws/:id/numbers/:number", async (req, res) => {
  try {
    const number = await updateNumberStatus(
      req.params.id,
      req.params.number,
      req.body?.status
    );
    return res.json({ ok: true, number });
  } catch (err) {
    return handleError(res, err, {
      logTag: "[PROMOTIONAL_ADMIN_NUMBERS_ERROR]",
      friendlyError: "Erro ao processar número promocional.",
    });
  }
});

router.post("/draws/:id/assign-numbers", async (req, res) => {
  try {
    const result = await assignNumbersToUser(req.params.id, req.body || {});
    return res.status(201).json({
      ok: true,
      ...result,
    });
  } catch (err) {
    return handleError(res, err, {
      logTag: "[PROMOTIONAL_ADMIN_ASSIGN_NUMBERS_ERROR]",
      friendlyError: "Erro ao atribuir número promocional.",
    });
  }
});

router.get("/draws/:id/participants", async (req, res) => {
  try {
    const participants = await listParticipants(req.params.id);
    return res.json({ ok: true, participants });
  } catch (err) {
    return handleError(res, err);
  }
});

router.patch("/draws/:id/status", async (req, res) => {
  try {
    const draw = await changeDrawStatus(req.params.id, req.body?.status);
    return res.json({ ok: true, draw });
  } catch (err) {
    return handleError(res, err);
  }
});

router.get("/draws/:id", async (req, res) => {
  try {
    const draw = await getAdminDraw(req.params.id);
    return res.json({ ok: true, draw });
  } catch (err) {
    return handleError(res, err);
  }
});

router.put("/draws/:id", async (req, res) => {
  try {
    const draw = await updateDraw(req.params.id, req.body || {});
    return res.json({ ok: true, draw });
  } catch (err) {
    return handleError(res, err);
  }
});

router.delete("/draws/:id", async (req, res) => {
  try {
    const draw = await archiveDraw(req.params.id);
    return res.json({ ok: true, draw });
  } catch (err) {
    return handleError(res, err);
  }
});

export default router;
