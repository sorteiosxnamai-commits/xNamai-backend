import assert from "node:assert/strict";
import test from "node:test";

import {
  creditAdminAssignmentCashback,
} from "../src/routes/adminUsers.js";
import {
  couponChannelForPayment,
} from "../src/routes/coupons.js";
import {
  creditCouponOnApprovedPayment,
} from "../src/services/couponBalance.js";

class InMemoryCouponPgClient {
  constructor({ payment, draw, userBalanceCents = 0, ledger = [] }) {
    this.payment = { ...payment };
    this.draw = { ...draw };
    this.user = {
      id: Number(payment.user_id),
      coupon_value_cents: userBalanceCents,
    };
    this.ledger = ledger.map((entry) => ({ ...entry }));
    this.calls = [];
  }

  async query(sql, params) {
    this.calls.push({ sql, params });

    assert.match(sql, /LEAST\(100,\s*GREATEST\(0,\s*b\.raw_cashback_percent\)\)/);
    assert.match(sql, /COALESCE\(b\.amount_cents,\s*b\.qty \* b\.draw_unit_cents/);
    assert.match(sql, /FLOOR\(\(c\.gross_amount_cents::numeric \* c\.cashback_percent::numeric\) \/ 100\)/);
    assert.match(sql, /ON CONFLICT DO NOTHING/);
    assert.match(sql, /c\.delta_cents = 0/);

    const [paymentId, fallbackUnitCents, channel, runTraceId, metaJson] = params;
    const payment = this.payment.id === paymentId ? this.payment : null;

    if (!payment) {
      return {
        rows: [{
          history_rows: 0,
          user_rows: 0,
          payment_rows: 0,
          user_id: null,
          status_l: null,
          qty: null,
          unit_cents: null,
          delta_cents: null,
          already_in_ledger: false,
          already_credited: false,
        }],
      };
    }

    const status = String(payment.status || "").toLowerCase();
    const isFinal = ["approved", "paid", "pago"].includes(status);
    const numbers = Array.isArray(payment.numbers) ? payment.numbers : [];
    const qty = numbers.length;
    const rawPercent = Number(this.draw.cashback_percent ?? 100);
    const cashbackPercent = Math.min(100, Math.max(0, rawPercent));
    const drawUnitCents = Number(
      this.draw.price_cents ||
      this.draw.ticket_price_cents ||
      fallbackUnitCents
    );
    const grossAmountCents = qty > 0
      ? Number(payment.amount_cents ?? qty * drawUnitCents)
      : Number(payment.amount_cents ?? 0);
    const unitCents = qty > 0
      ? Math.trunc(grossAmountCents / qty)
      : Number(payment.amount_cents ?? fallbackUnitCents);
    const deltaCents = Math.floor((grossAmountCents * cashbackPercent) / 100);
    const wasCredited = Boolean(payment.coupon_credited);
    const existingLedger = this.ledger.find(
      (entry) =>
        entry.payment_id === paymentId &&
        entry.event_type === "CREDIT_PURCHASE"
    );

    let historyRows = 0;
    let userRows = 0;
    let paymentRows = 0;

    if (isFinal && !wasCredited && deltaCents > 0 && !existingLedger) {
      const balanceBeforeCents = this.user.coupon_value_cents;
      this.ledger.push({
        user_id: this.user.id,
        payment_id: paymentId,
        delta_cents: deltaCents,
        balance_before_cents: balanceBeforeCents,
        balance_after_cents: balanceBeforeCents + deltaCents,
        event_type: "CREDIT_PURCHASE",
        channel,
        status: "approved",
        draw_id: payment.draw_id,
        run_trace_id: runTraceId,
        meta: JSON.parse(metaJson),
        gross_amount_cents: grossAmountCents,
        cashback_percent: cashbackPercent,
        cashback_amount_cents: deltaCents,
      });
      this.user.coupon_value_cents += deltaCents;
      historyRows = 1;
      userRows = 1;
    }

    if (
      isFinal &&
      !wasCredited &&
      (
        deltaCents === 0 ||
        historyRows === 1 ||
        Boolean(existingLedger)
      )
    ) {
      payment.coupon_credited = true;
      payment.coupon_credited_at = new Date().toISOString();
      payment.coupon_cashback_percent = cashbackPercent;
      payment.coupon_amount_cents = deltaCents;
      paymentRows = 1;
    }

    return {
      rows: [{
        history_rows: historyRows,
        user_rows: userRows,
        payment_rows: paymentRows,
        user_id: this.user.id,
        status_l: status,
        qty,
        unit_cents: unitCents,
        delta_cents: deltaCents,
        already_in_ledger: Boolean(existingLedger),
        already_credited: wasCredited,
      }],
    };
  }
}

function createScenario({
  paymentId = "adminassign:11111111-1111-4111-8111-111111111111",
  amountCents = 10000,
  cashbackPercent = 100,
  numbers = [2],
  provider = "admin_assign",
} = {}) {
  const payment = {
    id: paymentId,
    user_id: 12,
    draw_id: 18,
    numbers,
    amount_cents: amountCents,
    status: "approved",
    provider,
    coupon_credited: false,
    coupon_credited_at: null,
    coupon_cashback_percent: null,
    coupon_amount_cents: null,
  };
  const draw = {
    id: 18,
    ticket_price_cents: 10000,
    price_cents: 5500,
    cashback_percent: cashbackPercent,
  };
  const pgClient = new InMemoryCouponPgClient({ payment, draw });

  return { payment: pgClient.payment, draw, pgClient };
}

async function creditAdminScenario(scenario) {
  const { payment, pgClient } = scenario;
  return creditAdminAssignmentCashback({
    paymentId: payment.id,
    drawId: payment.draw_id,
    userId: payment.user_id,
    numbers: payment.numbers,
    amountCents: payment.amount_cents,
    pgClient,
  });
}

test("caso 1: atribuição admin com cashback 100% credita R$ 100 e um ledger", async () => {
  const scenario = createScenario();

  const result = await creditAdminScenario(scenario);

  assert.equal(result.action, "credited");
  assert.equal(result.delta_cents, 10000);
  assert.equal(scenario.payment.status, "approved");
  assert.equal(scenario.payment.coupon_credited, true);
  assert.ok(scenario.payment.coupon_credited_at);
  assert.equal(scenario.payment.coupon_cashback_percent, 100);
  assert.equal(scenario.payment.coupon_amount_cents, 10000);
  assert.equal(scenario.pgClient.user.coupon_value_cents, 10000);
  assert.equal(scenario.pgClient.ledger.length, 1);
  assert.equal(scenario.pgClient.ledger[0].channel, "ADMIN");
  assert.equal(scenario.pgClient.ledger[0].gross_amount_cents, 10000);
  assert.equal(scenario.pgClient.ledger[0].cashback_percent, 100);
  assert.equal(scenario.pgClient.ledger[0].cashback_amount_cents, 10000);
});

test("caso 2: atribuição admin com cashback 50% credita R$ 50", async () => {
  const scenario = createScenario({ cashbackPercent: 50 });

  await creditAdminScenario(scenario);

  assert.equal(scenario.pgClient.user.coupon_value_cents, 5000);
  assert.equal(scenario.payment.coupon_cashback_percent, 50);
  assert.equal(scenario.payment.coupon_amount_cents, 5000);
});

test("caso 3: cashback 0% não altera saldo e marca o payment como processado", async () => {
  const scenario = createScenario({ cashbackPercent: 0 });

  const result = await creditAdminScenario(scenario);

  assert.equal(result.action, "noop");
  assert.equal(result.reason, "zero_cashback");
  assert.equal(scenario.pgClient.user.coupon_value_cents, 0);
  assert.equal(scenario.pgClient.ledger.length, 0);
  assert.equal(scenario.payment.coupon_credited, true);
  assert.equal(scenario.payment.coupon_cashback_percent, 0);
  assert.equal(scenario.payment.coupon_amount_cents, 0);
});

test("caso 4: três números usam amount_cents de R$ 300 e creditam 50%", async () => {
  const scenario = createScenario({
    amountCents: 30000,
    cashbackPercent: 50,
    numbers: [2, 3, 4],
  });

  const result = await creditAdminScenario(scenario);

  assert.equal(result.qty, 3);
  assert.equal(result.delta_cents, 15000);
  assert.equal(scenario.pgClient.user.coupon_value_cents, 15000);
  assert.equal(scenario.pgClient.ledger[0].gross_amount_cents, 30000);
  assert.equal(scenario.pgClient.ledger[0].cashback_amount_cents, 15000);
});

test("caso 5: reprocessar o mesmo adminassign não duplica saldo nem ledger", async () => {
  const scenario = createScenario();

  const first = await creditAdminScenario(scenario);
  const second = await creditAdminScenario(scenario);

  assert.equal(first.action, "credited");
  assert.equal(second.action, "noop");
  assert.equal(second.reason, "already_in_ledger");
  assert.equal(scenario.pgClient.user.coupon_value_cents, 10000);
  assert.equal(scenario.pgClient.ledger.length, 1);
});

test("caso 6: sync recupera payment admin antigo ainda não creditado", async () => {
  const scenario = createScenario({
    paymentId: "adminassign:22222222-2222-4222-8222-222222222222",
  });
  const channel = couponChannelForPayment(scenario.payment);

  const result = await creditCouponOnApprovedPayment(scenario.payment.id, {
    channel,
    source: "coupons_sync",
    runTraceId: "coupons.sync#legacy",
    meta: { cashback_source: "draws.cashback_percent" },
    pgClient: scenario.pgClient,
  });

  assert.equal(result.action, "credited");
  assert.equal(channel, "ADMIN");
  assert.equal(scenario.pgClient.user.coupon_value_cents, 10000);
  assert.equal(scenario.pgClient.ledger.length, 1);
  assert.equal(scenario.pgClient.ledger[0].channel, "ADMIN");
});

test("caso 7: sync após crédito automático não gera novo crédito", async () => {
  const scenario = createScenario({
    paymentId: "adminassign:33333333-3333-4333-8333-333333333333",
  });
  await creditAdminScenario(scenario);

  const result = await creditCouponOnApprovedPayment(scenario.payment.id, {
    channel: couponChannelForPayment(scenario.payment),
    source: "coupons_sync",
    pgClient: scenario.pgClient,
  });

  assert.equal(result.action, "noop");
  assert.equal(result.reason, "already_in_ledger");
  assert.equal(scenario.pgClient.user.coupon_value_cents, 10000);
  assert.equal(scenario.pgClient.ledger.length, 1);
});

test("caso 8: canal de auditoria identifica admin sem alterar PIX e Vindi", () => {
  assert.equal(
    couponChannelForPayment({ id: "adminassign:legacy", provider: "mercadopago" }),
    "ADMIN"
  );
  assert.equal(
    couponChannelForPayment({ id: "payment-admin", provider: "admin_assign" }),
    "ADMIN"
  );
  assert.equal(
    couponChannelForPayment({ id: "payment-vindi", provider: "vindi" }),
    "VINDI"
  );
  assert.equal(
    couponChannelForPayment({ id: "payment-pix", provider: "mercadopago" }),
    "PIX"
  );
});

test("percentuais fora da faixa são limitados pelo serviço oficial a 0–100%", async () => {
  const above = createScenario({ cashbackPercent: 150 });
  const below = createScenario({
    paymentId: "adminassign:44444444-4444-4444-8444-444444444444",
    cashbackPercent: -20,
  });

  await creditAdminScenario(above);
  const belowResult = await creditAdminScenario(below);

  assert.equal(above.payment.coupon_cashback_percent, 100);
  assert.equal(above.payment.coupon_amount_cents, 10000);
  assert.equal(belowResult.reason, "zero_cashback");
  assert.equal(below.payment.coupon_cashback_percent, 0);
  assert.equal(below.pgClient.user.coupon_value_cents, 0);
});
