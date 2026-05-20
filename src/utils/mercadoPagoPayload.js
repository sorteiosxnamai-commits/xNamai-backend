function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function splitFullName(fullName) {
  const clean = String(fullName || "").trim().replace(/\s+/g, " ");

  if (!clean) {
    return {
      first_name: "Cliente",
      last_name: "xNaMai",
    };
  }

  const parts = clean.split(" ");
  const firstName = parts.shift() || "Cliente";
  const lastName = parts.length ? parts.join(" ") : "xNaMai";

  return {
    first_name: firstName.slice(0, 32),
    last_name: lastName.slice(0, 32),
  };
}

function normalizeCpf(cpf) {
  const digits = onlyDigits(cpf);
  return digits.length === 11 ? digits : null;
}

function normalizeCep(zipCode) {
  const digits = onlyDigits(zipCode);
  return digits.length === 8 ? digits : null;
}

function parseBrazilPhone(phone) {
  const digits = onlyDigits(phone);

  if (digits.length < 10) return null;

  const normalized = digits.startsWith("55") && digits.length > 11
    ? digits.slice(2)
    : digits;

  const areaCode = normalized.slice(0, 2);
  const number = normalized.slice(2);

  if (!areaCode || !number) return null;

  return {
    area_code: areaCode,
    number,
  };
}

function padNumber(value) {
  return String(Number(value)).padStart(2, "0");
}

function buildMercadoPagoPixPayload({
  user,
  draw,
  reservation,
  numbers,
  amountCents,
  ticketPriceCents,
  reservationId,
  notificationUrl,
  expirationDate,
}) {
  const amount = Number(amountCents || 0) / 100;
  const unitPrice = Number(ticketPriceCents || 0) / 100;

  const numbersList = Array.isArray(numbers)
    ? numbers.map(padNumber)
    : [];

  const numbersLabel = numbersList.join(", ");

  const fullName =
    user?.name ||
    user?.full_name ||
    reservation?.buyer_name ||
    "Cliente xNaMai";

  const email =
    user?.email ||
    reservation?.buyer_email ||
    reservation?.email ||
    "";

  const { first_name, last_name } = splitFullName(fullName);

  const cpf = normalizeCpf(
    user?.cpf ||
    reservation?.cpf ||
    reservation?.buyer_document
  );

  const phone = parseBrazilPhone(
    user?.phone ||
    reservation?.phone ||
    reservation?.buyer_phone
  );

  const zipCode = normalizeCep(
    user?.zip_code ||
    reservation?.zip_code
  );

  const payer = {
    email,
    first_name,
    last_name,
  };

  if (cpf) {
    payer.identification = {
      type: "CPF",
      number: cpf,
    };
  }

  if (phone) {
    payer.phone = phone;
  }

  if (zipCode || user?.street || user?.street_number) {
    payer.address = {
      ...(zipCode ? { zip_code: zipCode } : {}),
      ...(user?.street ? { street_name: String(user.street).slice(0, 80) } : {}),
      ...(user?.street_number
        ? { street_number: String(user.street_number).slice(0, 10) }
        : {}),
    };
  }

  return {
    transaction_amount: amount,
    description: `xNaMai Sorteios - número(s) ${numbersLabel}`,
    payment_method_id: "pix",
    payer,
    external_reference: String(reservationId),
    notification_url: notificationUrl,
    date_of_expiration: expirationDate,

    additional_info: {
      items: [
        {
          id: `draw-${draw?.id || "main"}`,
          title: `Sorteio xNaMai ${draw?.id || ""}`.trim(),
          description: `Participação no sorteio xNaMai - número(s): ${numbersLabel}`,
          quantity: numbersList.length || 1,
          unit_price: unitPrice || amount,
        },
      ],
      payer: {
        first_name,
        last_name,
        ...(phone ? { phone } : {}),
        ...(zipCode || user?.street || user?.street_number || user?.city || user?.state
          ? {
              address: {
                ...(zipCode ? { zip_code: zipCode } : {}),
                ...(user?.street ? { street_name: String(user.street).slice(0, 80) } : {}),
                ...(user?.street_number
                  ? { street_number: String(user.street_number).slice(0, 10) }
                  : {}),
                ...(user?.neighborhood
                  ? { neighborhood: String(user.neighborhood).slice(0, 80) }
                  : {}),
                ...(user?.city ? { city: String(user.city).slice(0, 80) } : {}),
                ...(user?.state
                  ? { federal_unit: String(user.state).toUpperCase().slice(0, 2) }
                  : {}),
              },
            }
          : {}),
        ...(user?.created_at ? { registration_date: user.created_at } : {}),
      },
    },

    metadata: {
      source: "xnamai_main_raffle",
      user_id: user?.id || null,
      draw_id: draw?.id || null,
      reservation_id: reservationId,
      numbers: numbersList,
      numbers_count: numbersList.length,
    },
  };
}

function maskDocument(value) {
  const digits = onlyDigits(value);
  if (digits.length < 5) return "***";
  return `${digits.slice(0, 3)}***${digits.slice(-2)}`;
}

export {
  onlyDigits,
  normalizeCpf,
  normalizeCep,
  parseBrazilPhone,
  splitFullName,
  buildMercadoPagoPixPayload,
  maskDocument,
};
