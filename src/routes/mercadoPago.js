import express from "express";
import { Pool } from "pg";

const router = express.Router();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
  max: Number(process.env.PG_POOL_MAX || 3),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT || 10000),
  connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT || 20000),
});

const MP_API = "https://api.mercadopago.com";

function getAccessToken() {
  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) {
    throw new Error("MP_ACCESS_TOKEN não configurado no Render");
  }
  return token.trim();
}

async function mpRequest(path, options = {}) {
  const token = getAccessToken();

  const response = await fetch(`${MP_API}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error("[MercadoPago] erro:", response.status, data);
    const message = data?.message || data?.error || "Erro no Mercado Pago";
    throw new Error(message);
  }

  return data;
}

async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments_mp (
      id SERIAL PRIMARY KEY,
      payment_id TEXT UNIQUE,
      external_reference TEXT,
      status TEXT DEFAULT 'pending',
      status_detail TEXT,
      amount_cents INTEGER NOT NULL DEFAULT 0,
      payer_email TEXT,
      payer_name TEXT,
      qr_code TEXT,
      qr_code_base64 TEXT,
      raw JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

ensureTables().catch((err) => {
  console.error("[MercadoPago] erro criando tabela:", err);
});

router.get("/public-key", (_req, res) => {
  res.json({
    publicKey: process.env.MP_PUBLIC_KEY || "",
  });
});

router.post("/pix", async (req, res) => {
  try {
    await ensureTables();

    const {
      amount,
      amountCents,
      description,
      email,
      payerEmail,
      name,
      payerName,
      phone,
      numbers,
      reservationId,
      drawId,
      orderId,
    } = req.body || {};

    const finalAmountCents = Number.isFinite(Number(amountCents))
      ? Number(amountCents)
      : Math.round(Number(amount || 0) * 100);

    if (!finalAmountCents || finalAmountCents <= 0) {
      return res.status(400).json({
        error: "amount_required",
        message: "Valor do pagamento inválido.",
      });
    }

    const finalEmail = payerEmail || email || "comprador@xnamai.com";
    const finalName = payerName || name || "Cliente xNaMai";

    const externalReference =
      orderId ||
      reservationId ||
      `xnamai-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const body = {
      transaction_amount: finalAmountCents / 100,
      description: description || "Compra de números - xNaMai Sorteios",
      payment_method_id: "pix",
      external_reference: String(externalReference),
      payer: {
        email: finalEmail,
        first_name: finalName,
        phone: phone
          ? {
              number: String(phone).replace(/\D/g, ""),
            }
          : undefined,
      },
      metadata: {
        numbers: Array.isArray(numbers) ? numbers : [],
        reservation_id: reservationId || null,
        draw_id: drawId || null,
      },
    };

    const payment = await mpRequest("/v1/payments", {
      method: "POST",
      headers: {
        "X-Idempotency-Key": String(externalReference),
      },
      body: JSON.stringify(body),
    });

    const qr = payment?.point_of_interaction?.transaction_data?.qr_code || "";

    const qrBase64 =
      payment?.point_of_interaction?.transaction_data?.qr_code_base64 || "";

    await pool.query(
      `
      INSERT INTO payments_mp (
        payment_id,
        external_reference,
        status,
        status_detail,
        amount_cents,
        payer_email,
        payer_name,
        qr_code,
        qr_code_base64,
        raw
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (payment_id)
      DO UPDATE SET
        status = EXCLUDED.status,
        status_detail = EXCLUDED.status_detail,
        qr_code = EXCLUDED.qr_code,
        qr_code_base64 = EXCLUDED.qr_code_base64,
        raw = EXCLUDED.raw,
        updated_at = NOW()
      `,
      [
        String(payment.id),
        String(externalReference),
        payment.status || "pending",
        payment.status_detail || null,
        finalAmountCents,
        finalEmail,
        finalName,
        qr,
        qrBase64,
        payment,
      ]
    );

    return res.json({
      ok: true,
      provider: "mercadopago",
      paymentId: String(payment.id),
      id: String(payment.id),
      status: payment.status,
      status_detail: payment.status_detail,
      qr_code: qr,
      copy_paste_code: qr,
      qr_code_base64: qrBase64,
      amount: finalAmountCents / 100,
      amount_cents: finalAmountCents,
      external_reference: String(externalReference),
    });
  } catch (error) {
    console.error("[MercadoPago] criar PIX:", error);
    return res.status(500).json({
      error: "mp_pix_failed",
      message: error.message || "Falha ao criar PIX Mercado Pago.",
    });
  }
});

async function getPaymentStatus(req, res) {
  try {
    const paymentId = req.params.paymentId || req.params.id;

    if (!paymentId) {
      return res.status(400).json({
        error: "payment_id_required",
      });
    }

    const payment = await mpRequest(`/v1/payments/${paymentId}`);

    await pool.query(
      `
      UPDATE payments_mp
      SET
        status = $2,
        status_detail = $3,
        raw = $4,
        updated_at = NOW()
      WHERE payment_id = $1
      `,
      [
        String(payment.id),
        payment.status || "pending",
        payment.status_detail || null,
        payment,
      ]
    );

    return res.json({
      ok: true,
      paymentId: String(payment.id),
      id: String(payment.id),
      status: payment.status,
      status_detail: payment.status_detail,
      external_reference: payment.external_reference,
    });
  } catch (error) {
    console.error("[MercadoPago] consultar status:", error);
    return res.status(500).json({
      error: "mp_status_failed",
      message: error.message || "Falha ao consultar pagamento.",
    });
  }
}

router.get("/payment/:paymentId", getPaymentStatus);
router.get("/:paymentId", getPaymentStatus);

async function mercadoPagoWebhookHandler(req, res) {
  try {
    await ensureTables();

    const body = req.body || {};
    const query = req.query || {};

    const paymentId =
      body?.data?.id || body?.id || query?.["data.id"] || query?.id;

    if (!paymentId) {
      return res.status(200).json({
        ok: true,
        ignored: true,
        reason: "no_payment_id",
      });
    }

    const payment = await mpRequest(`/v1/payments/${paymentId}`);

    await pool.query(
      `
      INSERT INTO payments_mp (
        payment_id,
        external_reference,
        status,
        status_detail,
        amount_cents,
        payer_email,
        payer_name,
        raw
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (payment_id)
      DO UPDATE SET
        status = EXCLUDED.status,
        status_detail = EXCLUDED.status_detail,
        raw = EXCLUDED.raw,
        updated_at = NOW()
      `,
      [
        String(payment.id),
        payment.external_reference || null,
        payment.status || "pending",
        payment.status_detail || null,
        Math.round(Number(payment.transaction_amount || 0) * 100),
        payment?.payer?.email || null,
        payment?.payer?.first_name || null,
        payment,
      ]
    );

    return res.status(200).json({
      ok: true,
      paymentId: String(payment.id),
      status: payment.status,
    });
  } catch (error) {
    console.error("[MercadoPago] webhook:", error);
    return res.status(200).json({
      ok: false,
      error: "webhook_failed",
      message: error.message,
    });
  }
}

router.post("/webhook", mercadoPagoWebhookHandler);

export const mercadoPagoRouter = router;
export { mercadoPagoWebhookHandler };

