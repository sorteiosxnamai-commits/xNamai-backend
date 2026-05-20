export function getMercadoPagoAccessToken() {
  const raw =
    process.env.MP_ACCESS_TOKEN ||
    process.env.MERCADOPAGO_ACCESS_TOKEN ||
    process.env.MERCADO_PAGO_ACCESS_TOKEN ||
    process.env.REACT_APP_MP_ACCESS_TOKEN ||
    "";

  let token = String(raw || "").trim();

  if (token.toLowerCase().startsWith("bearer ")) {
    token = token.slice(7).trim();
  }

  token = token.replace(/\r/g, "").replace(/\n/g, "").trim();

  if (!token) {
    throw new Error("MP_ACCESS_TOKEN não configurado no servidor.");
  }

  if (/[\r\n\t]/.test(token)) {
    throw new Error("MP_ACCESS_TOKEN contém caracteres inválidos de quebra de linha/tab.");
  }

  if (/\s/.test(token)) {
    throw new Error("MP_ACCESS_TOKEN contém espaços inválidos. Cole o token em uma única linha no Render.");
  }

  if (!token.startsWith("APP_USR-") && !token.startsWith("TEST-")) {
    console.warn("[MP_TOKEN_WARN] Token Mercado Pago não começa com APP_USR- nem TEST-. Verifique ambiente.");
  }

  return token;
}

export function getMercadoPagoAuthHeader() {
  return `Bearer ${getMercadoPagoAccessToken()}`;
}

export function logMercadoPagoTokenHealth() {
  const raw =
    process.env.MP_ACCESS_TOKEN ||
    process.env.MERCADOPAGO_ACCESS_TOKEN ||
    process.env.MERCADO_PAGO_ACCESS_TOKEN ||
    process.env.REACT_APP_MP_ACCESS_TOKEN ||
    "";

  const s = String(raw || "");

  console.log("[MP_TOKEN_HEALTH]", {
    configured: Boolean(s),
    length: s.length,
    hasCR: s.includes("\r"),
    hasLF: s.includes("\n"),
    hasTab: s.includes("\t"),
    hasLeadingOrTrailingSpace: s !== s.trim(),
    startsWithBearer: s.trim().toLowerCase().startsWith("bearer "),
  });
}
