// backend/src/services/purchase_limit.js
import { query } from "../db.js";
import { fetchCurrentOpenDraw } from "./mainRaffleCompat.js";

const STATUSES = [
  "reservado", "pago", "pendente", "aprovado", "vendido", "indisponivel",
  "confirmado", "processando", "aguardando",
  "reserved", "paid", "pending", "approved", "sold", "taken",
  "confirmed", "processing", "awaiting",
];

async function resolveUserColumn(table) {
  const { rows } = await query(
    `
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
    `,
    [table]
  );
  const cols = rows.map((r) => r.column_name);
  const candidates = [
    "user_id", "client_id", "customer_id", "account_id",
    "buyer_id", "participant_id", "owner_id",
  ];
  return candidates.find((c) => cols.includes(c)) || null;
}

async function countViaNumbers(userId, drawId, userCol) {
  const sql = `
    SELECT COUNT(*)::int AS cnt
      FROM numbers
     WHERE draw_id = $1
       AND ${userCol} = $2
       AND LOWER(COALESCE(status, '')) = ANY($3)
  `;
  const { rows } = await query(sql, [
    drawId,
    userId,
    STATUSES.map((s) => s.toLowerCase()),
  ]);
  return rows?.[0]?.cnt ?? 0;
}

async function countViaReservations(userId, drawId) {
  const userCol = await resolveUserColumn("reservations");
  if (!userCol) return 0;

  const { rows: fkRows } = await query(
    `
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'reservations'
       AND column_name IN ('number_id', 'numbers_id', 'num_id', 'n_id')
    `
  );
  const numCol = fkRows?.[0]?.column_name || null;

  const { rows: drawRows } = await query(
    `
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'reservations'
       AND column_name IN ('draw_id', 'sorteio_id')
    `
  );
  const drawCol = drawRows?.[0]?.column_name || null;

  if (numCol) {
    const sql = `
      SELECT COUNT(*)::int AS cnt
        FROM reservations r
        JOIN numbers n ON n.id = r.${numCol}
       WHERE n.draw_id = $1
         AND r.${userCol} = $2
         AND LOWER(COALESCE(n.status, r.status, '')) = ANY($3)
    `;
    const { rows } = await query(sql, [
      drawId,
      userId,
      STATUSES.map((s) => s.toLowerCase()),
    ]);
    return rows?.[0]?.cnt ?? 0;
  }

  if (drawCol) {
    const sql = `
      SELECT COUNT(*)::int AS cnt
        FROM reservations r
       WHERE r.${drawCol} = $1
         AND r.${userCol} = $2
         AND LOWER(COALESCE(r.status, '')) = ANY($3)
    `;
    const { rows } = await query(sql, [
      drawId,
      userId,
      STATUSES.map((s) => s.toLowerCase()),
    ]);
    return rows?.[0]?.cnt ?? 0;
  }

  return 0;
}

export async function getMaxNumbersPerUserForDraw(drawId) {
  const id = Number(drawId);
  if (!Number.isInteger(id) || id <= 0) {
    const current = await fetchCurrentOpenDraw();
    return Number(current?.max_numbers_per_user || 5);
  }

  const { rows } = await query(
    `
    SELECT COALESCE(max_numbers_per_user, 5)::int AS max_numbers_per_user
      FROM public.draws
     WHERE id = $1
     LIMIT 1
    `,
    [id]
  );

  return Number(rows[0]?.max_numbers_per_user || 5);
}

export async function getUserCountInDraw(userId, drawId) {
  const userCol = await resolveUserColumn("numbers");
  if (userCol) return countViaNumbers(userId, drawId, userCol);
  return countViaReservations(userId, drawId);
}

export async function checkUserLimit(userId, drawId, addingCount = 1) {
  const max = await getMaxNumbersPerUserForDraw(drawId);
  const current = await getUserCountInDraw(userId, drawId);
  const blocked = current >= max || current + addingCount > max;
  return { blocked, current, max, max_numbers_per_user: max };
}

export async function assertUserUnderLimit(userId, drawId, addingCount = 1) {
  const { blocked, current, max } = await checkUserLimit(userId, drawId, addingCount);
  if (blocked) {
    const err = new Error("max_numbers_reached");
    err.status = 409;
    err.code = "max_numbers_reached";
    err.payload = { current, max, max_numbers_per_user: max };
    throw err;
  }
  return { current, max, max_numbers_per_user: max };
}
