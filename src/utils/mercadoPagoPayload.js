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

  const streetName = user?.street
    ? String(user.street).trim().slice(0, 80)
    : "";

  const streetNumber = user?.street_number
    ? String(user.street_number).trim().slice(0, 10)
    : "";

  const neighborhood = user?.neighborhood
    ? String(user.neighborhood).trim().slice(0, 80)
    : "";

  const city = user?.city
    ? String(user.city).trim().slice(0, 80)
    : "";

  const state = user?.state
    ? String(user.state).trim().toUpperCase().slice(0, 2)
    : "";

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
    payer.phone = {
      area_code: phone.area_code,
      number: phone.number,
    };
  }

  if (zipCode || streetName || streetNumber) {
    payer.address = {
      ...(zipCode ? { zip_code: zipCode } : {}),
      ...(streetName ? { street_name: streetName } : {}),
      ...(streetNumber ? { street_number: streetNumber } : {}),
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
        ...(phone
          ? {
              phone: {
                area_code: phone.area_code,
                number: phone.number,
              },
            }
          : {}),
        ...(zipCode || streetName || streetNumber
          ? {
              address: {
                ...(zipCode ? { zip_code: zipCode } : {}),
                ...(streetName ? { street_name: streetName } : {}),
                ...(streetNumber ? { street_number: streetNumber } : {}),
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

      customer_name: fullName,
      customer_email: email,
      customer_cpf_present: Boolean(cpf),
      customer_phone_present: Boolean(phone),
      customer_zip_code: zipCode || null,
      customer_street: streetName || null,
      customer_street_number: streetNumber || null,
      customer_neighborhood: neighborhood || null,
      customer_city: city || null,
      customer_state: state || null,
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
