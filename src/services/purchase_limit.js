// backend/src/services/purchase_limit.js
import { query } from "../db.js";

const PURCHASE_LIMIT_SQL = `
WITH draw_cfg AS (
  SELECT
    id AS draw_id,
    COALESCE(max_numbers_per_user, 5)::int AS max_numbers_per_user
  FROM public.draws
  WHERE id = $2
  LIMIT 1
),
paid_numbers AS (
  SELECT DISTINCT x.n::int AS n
  FROM public.payments p
  CROSS JOIN LATERAL unnest(COALESCE(p.numbers, '{}'::int[])) AS x(n)
  WHERE p.user_id = $1
    AND p.draw_id = $2
    AND LOWER(COALESCE(p.status, '')) IN ('approved','paid','pago')
),
active_reserved_numbers AS (
  SELECT DISTINCT x.n::int AS n
  FROM public.reservations r
  CROSS JOIN LATERAL unnest(COALESCE(r.numbers, '{}'::int[])) AS x(n)
  WHERE r.user_id = $1
    AND r.draw_id = $2
    AND LOWER(COALESCE(r.status, '')) IN ('active','reserved','pending','reservado','pendente')
    AND LOWER(COALESCE(r.payment_status, 'pending')) NOT IN ('paid','approved','pago','expired','cancelled','canceled')
    AND COALESCE(r.expires_at, r.created_at + interval '30 minutes') > NOW()
),
all_used AS (
  SELECT n FROM paid_numbers
  UNION
  SELECT n FROM active_reserved_numbers
)
SELECT
  d.draw_id,
  d.max_numbers_per_user,
  (SELECT COUNT(*)::int FROM paid_numbers) AS paid_count,
  (SELECT COUNT(*)::int FROM active_reserved_numbers) AS reserved_count,
  (SELECT COUNT(*)::int FROM all_used) AS used_count,
  GREATEST(0, d.max_numbers_per_user - (SELECT COUNT(*)::int FROM all_used)) AS remaining
FROM draw_cfg d
`;

export async function getPurchaseLimitUsage(userId, drawId) {
  const uid = Number(userId);
  const did = Number(drawId);
  if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(did) || did <= 0) {
    const err = new Error("invalid_purchase_limit_params");
    err.status = 400;
    throw err;
  }

  const { rows } = await query(PURCHASE_LIMIT_SQL, [uid, did]);
  if (!rows.length) {
    const err = new Error("draw_not_found");
    err.status = 404;
    throw err;
  }

  const row = rows[0];
  const max = Number(row.max_numbers_per_user || 5);
  const used = Number(row.used_count || 0);
  const remaining = Number(row.remaining ?? Math.max(0, max - used));

  return {
    draw_id: Number(row.draw_id),
    max_numbers_per_user: max,
    paid_count: Number(row.paid_count || 0),
    reserved_count: Number(row.reserved_count || 0),
    used_count: used,
    remaining,
  };
}

export async function checkPurchaseLimit(userId, drawId, add = 0) {
  const usage = await getPurchaseLimitUsage(userId, drawId);
  const requestedAdd = Math.max(0, Number(add) || 0);
  const canBuy =
    requestedAdd <= 0
      ? usage.remaining > 0
      : usage.used_count + requestedAdd <= usage.max_numbers_per_user;

  let message = null;
  if (!canBuy && requestedAdd > 0) {
    const n = usage.remaining;
    message =
      n === 1
        ? "Você pode selecionar apenas mais 1 número neste sorteio."
        : n === 0
          ? `Você já possui ${usage.used_count} de ${usage.max_numbers_per_user} números neste sorteio.`
          : `Você pode selecionar apenas mais ${n} números neste sorteio.`;
  }

  return {
    ok: true,
    ...usage,
    can_buy: canBuy,
    requested_add: requestedAdd > 0 ? requestedAdd : undefined,
    message,
    blocked: !canBuy,
    current: usage.used_count,
    max: usage.max_numbers_per_user,
  };
}

/** @deprecated use getPurchaseLimitUsage */
export async function getMaxNumbersPerUserForDraw(drawId) {
  const usage = await getPurchaseLimitUsage(0, drawId).catch(() => null);
  if (usage) return usage.max_numbers_per_user;
  const { rows } = await query(
    `SELECT COALESCE(max_numbers_per_user, 5)::int AS max_numbers_per_user
       FROM public.draws WHERE id = $1 LIMIT 1`,
    [Number(drawId)]
  );
  return Number(rows[0]?.max_numbers_per_user || 5);
}

/** @deprecated use getPurchaseLimitUsage */
export async function getUserCountInDraw(userId, drawId) {
  const usage = await getPurchaseLimitUsage(userId, drawId);
  return usage.used_count;
}

/** @deprecated use checkPurchaseLimit */
export async function checkUserLimit(userId, drawId, addingCount = 1) {
  const out = await checkPurchaseLimit(userId, drawId, addingCount);
  return {
    blocked: out.blocked,
    current: out.used_count,
    max: out.max_numbers_per_user,
    max_numbers_per_user: out.max_numbers_per_user,
  };
}

export async function assertUserUnderLimit(userId, drawId, addingCount = 1) {
  const usage = await getPurchaseLimitUsage(userId, drawId);
  const add = Math.max(1, Number(addingCount) || 1);
  if (usage.used_count + add > usage.max_numbers_per_user) {
    const err = new Error("purchase_limit_exceeded");
    err.status = 409;
    err.code = "purchase_limit_exceeded";
    const remaining = usage.remaining;
    err.payload = {
      ok: false,
      error: "purchase_limit_exceeded",
      message:
        remaining === 1
          ? `Você já possui ${usage.used_count} de ${usage.max_numbers_per_user} números neste sorteio. É possível selecionar apenas mais 1.`
          : remaining === 0
            ? `Você já possui ${usage.used_count} de ${usage.max_numbers_per_user} números neste sorteio.`
            : `Você já possui ${usage.used_count} de ${usage.max_numbers_per_user} números neste sorteio. É possível selecionar apenas mais ${remaining}.`,
      used_count: usage.used_count,
      max_numbers_per_user: usage.max_numbers_per_user,
      remaining,
    };
    throw err;
  }
  return usage;
}
