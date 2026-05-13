const DRAW_STATUSES = ["draft", "active", "inactive", "closed"];
const NUMBER_STATUSES = ["available", "reserved", "sold", "blocked"];
const RESERVATION_STATUSES = ["pending", "paid", "expired", "cancelled"];

function validationError(message, details = undefined) {
  const err = new Error(message);
  err.status = 400;
  err.code = "validation_error";
  if (details) err.details = details;
  return err;
}

function toInt(value, field, fallback = undefined) {
  if (value === undefined || value === null || value === "") {
    if (fallback !== undefined) return fallback;
    throw validationError(`${field} é obrigatório.`);
  }

  const n = Number(value);
  if (!Number.isInteger(n)) {
    throw validationError(`${field} deve ser um número inteiro.`);
  }

  return n;
}

function toOptionalDate(value, field) {
  if (value === undefined || value === null || value === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw validationError(`${field} deve ser uma data válida.`);
  }
  return date.toISOString();
}

function sanitizeString(value, max = 255) {
  return String(value ?? "").trim().slice(0, max);
}

export function validatePromotionalStatus(status) {
  const normalized = String(status || "draft").trim().toLowerCase();
  if (!DRAW_STATUSES.includes(normalized)) {
    throw validationError("Status de sorteio promocional inválido.", {
      allowed: DRAW_STATUSES,
    });
  }
  return normalized;
}

export function validateNumberStatus(status) {
  const normalized = String(status || "available").trim().toLowerCase();
  if (!NUMBER_STATUSES.includes(normalized)) {
    throw validationError("Status de número promocional inválido.", {
      allowed: NUMBER_STATUSES,
    });
  }
  return normalized;
}

export function validateReservationStatus(status) {
  const normalized = String(status || "pending").trim().toLowerCase();
  if (!RESERVATION_STATUSES.includes(normalized)) {
    throw validationError("Status de reserva promocional inválido.", {
      allowed: RESERVATION_STATUSES,
    });
  }
  return normalized;
}

export function validateNumberRange(number_start, number_end) {
  const start = toInt(number_start, "number_start");
  const end = toInt(number_end, "number_end");

  if (start < 0) throw validationError("number_start deve ser maior ou igual a 0.");
  if (end > 1000) throw validationError("number_end deve ser menor ou igual a 1000.");
  if (end <= start) throw validationError("number_end deve ser maior que number_start.");

  return {
    number_start: start,
    number_end: end,
  };
}

export function validateCreatePromotionalDraw(payload = {}) {
  const title = sanitizeString(payload.title);
  if (!title) throw validationError("title é obrigatório.");

  const range = validateNumberRange(payload.number_start, payload.number_end);
  const price_cents = toInt(payload.price_cents ?? 0, "price_cents", 0);
  const max_numbers_per_user = toInt(
    payload.max_numbers_per_user ?? 1,
    "max_numbers_per_user",
    1
  );

  if (price_cents <= 0) {
    throw validationError("price_cents deve ser maior que 0 para permitir pagamento PIX.");
  }
  if (max_numbers_per_user <= 0) {
    throw validationError("max_numbers_per_user deve ser maior que 0.");
  }

  return {
    title,
    description: sanitizeString(payload.description, 5000),
    prize: sanitizeString(payload.prize, 255),
    price_cents,
    ...range,
    max_numbers_per_user,
    status: validatePromotionalStatus(payload.status || "draft"),
    banner_url: sanitizeString(payload.banner_url, 2048),
    starts_at: toOptionalDate(payload.starts_at, "starts_at"),
    ends_at: toOptionalDate(payload.ends_at, "ends_at"),
  };
}

export function validateUpdatePromotionalDraw(payload = {}) {
  const patch = {};

  if (payload.title !== undefined) {
    patch.title = sanitizeString(payload.title);
    if (!patch.title) throw validationError("title não pode ser vazio.");
  }
  if (payload.description !== undefined) {
    patch.description = sanitizeString(payload.description, 5000);
  }
  if (payload.prize !== undefined) {
    patch.prize = sanitizeString(payload.prize, 255);
  }
  if (payload.price_cents !== undefined) {
    patch.price_cents = toInt(payload.price_cents, "price_cents");
    if (patch.price_cents <= 0) {
      throw validationError("price_cents deve ser maior que 0 para permitir pagamento PIX.");
    }
  }
  if (payload.max_numbers_per_user !== undefined) {
    patch.max_numbers_per_user = toInt(payload.max_numbers_per_user, "max_numbers_per_user");
    if (patch.max_numbers_per_user <= 0) {
      throw validationError("max_numbers_per_user deve ser maior que 0.");
    }
  }
  if (payload.status !== undefined) {
    patch.status = validatePromotionalStatus(payload.status);
  }
  if (payload.banner_url !== undefined) {
    patch.banner_url = sanitizeString(payload.banner_url, 2048);
  }
  if (payload.starts_at !== undefined) {
    patch.starts_at = toOptionalDate(payload.starts_at, "starts_at");
  }
  if (payload.ends_at !== undefined) {
    patch.ends_at = toOptionalDate(payload.ends_at, "ends_at");
  }

  if (!Object.keys(patch).length) {
    throw validationError("Nenhum campo válido para atualização.");
  }

  return patch;
}

export function validateReservationPayload(payload = {}, user = null) {
  const numbers = Array.isArray(payload.numbers)
    ? [...new Set(payload.numbers.map(Number))]
    : [];

  const validNumbers = numbers.filter((n) => Number.isInteger(n) && n >= 0 && n <= 1000);
  if (!validNumbers.length || validNumbers.length !== numbers.length) {
    throw validationError("numbers deve conter números inteiros entre 0 e 1000.");
  }

  const name = sanitizeString(payload.name ?? payload.buyer_name ?? user?.name ?? "", 255);
  const email = sanitizeString(payload.email ?? payload.buyer_email ?? user?.email ?? "", 255);
  const phone = sanitizeString(payload.phone ?? payload.buyer_phone ?? user?.phone ?? "", 40);

  if (!email) throw validationError("buyer_email é obrigatório para participação promocional.");

  return {
    numbers: validNumbers,
    name: name || email,
    email,
    phone,
    user_id: Number.isInteger(Number(user?.id)) ? Number(user.id) : null,
  };
}
