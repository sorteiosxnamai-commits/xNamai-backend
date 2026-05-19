import { query } from "../db.js";
import { ensureMainRaffleCompat } from "./mainRaffleCompat.js";

function runner(client) {
  return client && typeof client.query === "function"
    ? (sql, params = []) => client.query(sql, params)
    : (sql, params = []) => query(sql, params);
}

export async function cleanupExpiredMainReservations(client = null, drawId = null) {
  const q = runner(client);

  await ensureMainRaffleCompat(client);

  const params = [];
  let drawWhereReservations = "";
  let drawWhereNumbers = "";

  if (drawId !== null && drawId !== undefined && drawId !== "") {
    params.push(Number(drawId));
    drawWhereReservations = `AND draw_id = $1`;
    drawWhereNumbers = `AND draw_id = $1`;
  }

  await q(
    `
    UPDATE public.reservations
       SET status = 'expired',
           payment_status = 'expired',
           updated_at = NOW()
     WHERE expires_at IS NOT NULL
       AND expires_at <= NOW()
       ${drawWhereReservations}
       AND LOWER(COALESCE(status, '')) IN ('active', 'pending', 'reserved', 'reservado', 'pendente')
       AND LOWER(COALESCE(payment_status, 'pending')) NOT IN ('paid', 'approved', 'pago')
    `,
    params
  );

  await q(
    `
    UPDATE public.numbers
       SET status = 'available',
           reservation_id = NULL,
           user_id = NULL,
           payment_status = 'pending',
           payment_id = NULL,
           reserved_at = NULL,
           reserved_until = NULL,
           updated_at = NOW()
     WHERE reserved_until IS NOT NULL
       AND reserved_until <= NOW()
       ${drawWhereNumbers}
       AND LOWER(COALESCE(status, '')) IN ('reserved', 'pending', 'reservado', 'pendente')
       AND LOWER(COALESCE(payment_status, 'pending')) NOT IN ('paid', 'approved', 'pago')
    `,
    params
  );
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
