import { query } from "../db.js";
import { ensureMainRaffleCompat } from "./mainRaffleCompat.js";

function runner(client) {
  return client && typeof client.query === "function"
    ? (sql, params = []) => client.query(sql, params)
    : (sql, params = []) => query(sql, params);
}

const ACTIVE_RESERVATION_STATUSES = [
  "active",
  "pending",
  "reserved",
  "reservado",
  "pendente",
];

const PAID_PAYMENT_STATUSES = ["paid", "approved", "pago"];
const RESERVED_NUMBER_STATUSES = ["reserved", "pending", "reservado", "pendente"];
const PAID_NUMBER_STATUSES = ["sold", "paid", "approved", "pago", "vendido", "aprovado"];

/** Reserva pública (não admin/manual). */
const PUBLIC_SOURCE_SQL = `LOWER(COALESCE(source, 'public')) IN ('public', '')`;

export async function cleanupExpiredMainReservations(client = null, drawId = null) {
  const q = runner(client);

  await ensureMainRaffleCompat(client);

  const params = [];
  let drawWhereReservations = "";
  let drawWhereNumbers = "";

  if (drawId !== null && drawId !== undefined && drawId !== "") {
    params.push(Number(drawId));
    drawWhereReservations = `AND draw_id = $1`;
    drawWhereNumbers = `AND n.draw_id = $1`;
  }

  const activeStatusList = ACTIVE_RESERVATION_STATUSES.map((s) => `'${s}'`).join(", ");
  const paidStatusList = PAID_PAYMENT_STATUSES.map((s) => `'${s}'`).join(", ");
  const reservedStatusList = RESERVED_NUMBER_STATUSES.map((s) => `'${s}'`).join(", ");
  const paidNumberList = PAID_NUMBER_STATUSES.map((s) => `'${s}'`).join(", ");

  const expiredReservationsResult = await q(
    `
    UPDATE public.reservations
       SET status = 'expired',
           payment_status = 'expired',
           updated_at = NOW()
     WHERE COALESCE(expires_at, created_at + interval '30 minutes') <= NOW()
       ${drawWhereReservations}
       AND ${PUBLIC_SOURCE_SQL}
       AND LOWER(COALESCE(status, '')) IN (${activeStatusList})
       AND LOWER(COALESCE(payment_status, 'pending')) NOT IN (${paidStatusList})
       AND LOWER(COALESCE(status, '')) NOT IN (${paidStatusList})
     RETURNING id, reservation_group_id, draw_id
    `,
    params
  );

  const expiredReservations = Number(expiredReservationsResult.rowCount || 0);

  const drawFilterR = drawWhereReservations
    ? drawWhereReservations.replace(/draw_id/g, "r.draw_id")
    : "";

  const releasedNumbersResult = await q(
    `
    UPDATE public.numbers n
       SET status = 'available',
           reservation_id = NULL,
           user_id = NULL,
           payment_status = 'pending',
           payment_id = NULL,
           reserved_at = NULL,
           reserved_until = NULL,
           updated_at = NOW()
     WHERE LOWER(COALESCE(n.status, '')) IN (${reservedStatusList})
       AND LOWER(COALESCE(n.status, '')) NOT IN (${paidNumberList})
       AND LOWER(COALESCE(n.payment_status, 'pending')) NOT IN (${paidStatusList})
       AND NOT EXISTS (
         SELECT 1
           FROM public.payments p
          WHERE p.draw_id = n.draw_id
            AND LOWER(COALESCE(p.status, '')) IN (${paidStatusList})
            AND COALESCE(n.n::int, n.number) = ANY(COALESCE(p.numbers, '{}'::int[]))
       )
       AND (
         (
           n.reserved_until IS NOT NULL
           AND n.reserved_until <= NOW()
         )
         OR EXISTS (
           SELECT 1
             FROM public.reservations r
            WHERE COALESCE(r.expires_at, r.created_at + interval '30 minutes') <= NOW()
              ${drawFilterR}
              AND LOWER(COALESCE(r.source, 'public')) IN ('public', '')
              AND LOWER(COALESCE(r.payment_status, 'pending')) NOT IN (${paidStatusList})
              AND (
                n.reservation_id::text = r.id::text
                OR n.reservation_id::text = r.reservation_group_id::text
              )
         )
         OR (
           n.reservation_id IS NULL
           AND EXISTS (
             SELECT 1
               FROM public.reservations r
              WHERE r.draw_id = n.draw_id
                AND COALESCE(r.expires_at, r.created_at + interval '30 minutes') <= NOW()
                ${drawFilterR}
                AND LOWER(COALESCE(r.source, 'public')) IN ('public', '')
                AND LOWER(COALESCE(r.payment_status, 'pending')) NOT IN (${paidStatusList})
                AND COALESCE(n.n::int, n.number) = ANY(COALESCE(r.numbers, '{}'::int[]))
           )
           AND NOT EXISTS (
             SELECT 1
               FROM public.reservations active_r
              WHERE active_r.draw_id = n.draw_id
                AND COALESCE(n.n::int, n.number) = ANY(COALESCE(active_r.numbers, '{}'::int[]))
                AND LOWER(COALESCE(active_r.status, '')) IN ('reserved', 'active', 'pending', 'reservado', 'pendente')
                AND LOWER(COALESCE(active_r.payment_status, 'pending')) NOT IN ('paid', 'approved', 'pago', 'expired', 'cancelled', 'canceled')
                AND COALESCE(active_r.expires_at, active_r.created_at + interval '30 minutes') > NOW()
           )
         )
       )
       ${drawWhereNumbers}
     RETURNING COALESCE(n.n::int, n.number) AS num, n.draw_id
    `,
    params
  );

  const releasedNumbers = Number(releasedNumbersResult.rowCount || 0);
  const logDrawId =
    drawId != null && drawId !== ""
      ? Number(drawId)
      : releasedNumbersResult.rows?.[0]?.draw_id ??
        expiredReservationsResult.rows?.[0]?.draw_id ??
        null;

  if (expiredReservations > 0 || releasedNumbers > 0) {
    console.log("[MAIN_RESERVATION_EXPIRED_CLEANUP]", {
      drawId: logDrawId,
      expiredReservations,
      releasedNumbers,
    });
  }

  return { expiredReservations, releasedNumbers, drawId: logDrawId };
}

export async function ensureMainNumbersExist(client, drawId, nums) {
  const q = runner(client);

  await ensureMainRaffleCompat(client);

  await q(
    `
    INSERT INTO public.numbers (
      draw_id,
      n,
      number,
      status,
      payment_status,
      created_at,
      updated_at
    )
    SELECT
      $1,
      selected_number::smallint,
      selected_number::int,
      'available',
      'pending',
      NOW(),
      NOW()
    FROM UNNEST($2::int[]) AS selected_number
    WHERE NOT EXISTS (
      SELECT 1
        FROM public.numbers existing
       WHERE existing.draw_id = $1
         AND COALESCE(existing.n::int, existing.number) = selected_number
    )
    `,
    [Number(drawId), nums.map(Number)]
  );
}
