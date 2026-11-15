import assert from "node:assert/strict";
import test from "node:test";
import { applyAction, createInitialState, markProcessing, settleInvoice } from "../lib/mesh/engine";
import type { MeshState } from "../lib/mesh/types";

function negotiated(state = createInitialState()) {
  return applyAction(state, { type: "negotiate", invoiceId: "inv_seed_design" });
}

function authorized() {
  return applyAction(negotiated(), { type: "approve", invoiceId: "inv_seed_design" });
}

test("initial workspace marks its seed receipts as demo and balances every owner's ledger", () => {
  const state = createInitialState();
  assert.equal(state.accounts.length, 3);
  assert.equal(state.receipts.length, 2);
  assert.ok(state.receipts.every((r) => r.mode === "demo"));
  for (const owner of state.accounts) {
    const lines = state.ledger.filter((l) => l.accountId === owner.id);
    assert.equal(lines.reduce((s, l) => s + l.debitCents - l.creditCents, 0), 0);
  }
});

test("negotiation corrects the invoice against its quote without changing the input", () => {
  const before = createInitialState();
  const snapshot = structuredClone(before);
  const after = negotiated(before);
  const item = after.invoices.find((i) => i.id === "inv_seed_design")!;
  assert.deepEqual(before, snapshot);
  assert.equal(item.amountCents, 10_000);
  assert.equal(item.originalAmountCents, 12_000);
  assert.equal(item.status, "awaiting_approval");
  const exchange = after.messages.filter((m) => m.invoiceId === item.id);
  assert.ok(exchange.some((m) => m.from === "acme" && m.kind === "negotiation"));
  assert.ok(exchange.some((m) => m.from === "maya" && m.kind === "negotiation"));
  assert.ok(exchange.some((m) => m.kind === "policy"));
});

test("the run demo action creates the $120 to $100 discrepancy scenario", () => {
  const before = createInitialState();
  const after = applyAction(before, { type: "run_demo", rail: "crypto" });
  const item = after.invoices.at(-1)!;
  assert.equal(after.invoices.length, before.invoices.length + 1);
  assert.equal(item.from, "maya");
  assert.equal(item.to, "acme");
  assert.equal(item.originalAmountCents, 12_000);
  assert.equal(item.amountCents, 10_000);
  assert.equal(item.currency, "USDC");
  assert.equal(item.status, "awaiting_approval");
});

test("existing owner policy can automatically authorize a matching small invoice", () => {
  let state = createInitialState();
  state = applyAction(state, { type: "create_invoice", from: "maya", to: "alex", description: "Shared taxi", amountCents: 2_000, rail: "crypto" });
  const id = state.invoices.at(-1)!.id;
  state = applyAction(state, { type: "negotiate", invoiceId: id });
  assert.equal(state.invoices.at(-1)!.status, "approved");
  assert.equal(state.receipts.length, 2);
});

test("a draft cannot be approved or settled, and corrected invoices cannot negotiate twice", () => {
  assert.throws(() => applyAction(createInitialState(), { type: "approve", invoiceId: "inv_seed_design" }), /awaiting approval/);
  assert.throws(() => settleInvoice(createInitialState(), "inv_seed_design", { reference: "demo_test", mode: "demo" }), /authorized/);
  assert.throws(() => applyAction(negotiated(), { type: "negotiate", invoiceId: "inv_seed_design" }), /draft/);
});

test("manual approval and execution both enforce the daily cap and allowed rail", () => {
  let state = negotiated();
  state = applyAction(state, { type: "update_policy", accountId: "acme", policy: { autoApproveCents: 0, dailyLimitCents: 9_000, allowedRails: ["stripe"] } });
  assert.throws(() => applyAction(state, { type: "approve", invoiceId: "inv_seed_design" }), /daily spending limit/);
  state = authorized();
  state = applyAction(state, { type: "update_policy", accountId: "acme", policy: { autoApproveCents: 0, dailyLimitCents: 500_000, allowedRails: ["crypto"] } });
  assert.throws(() => settleInvoice(state, "inv_seed_design", { reference: "demo_blocked", mode: "demo" }), /does not allow stripe/);
});

test("settlement posts exactly four balanced entries, one receipt, and transfers the amount once", () => {
  const state = authorized();
  const payer = state.accounts.find((a) => a.id === "acme")!.balanceCents;
  const payee = state.accounts.find((a) => a.id === "maya")!.balanceCents;
  const proof = { reference: "demo_once", mode: "demo" as const };
  const result = settleInvoice(state, "inv_seed_design", proof);
  assert.equal(result.ledger.length, state.ledger.length + 4);
  assert.equal(result.receipts.length, state.receipts.length + 1);
  assert.equal(result.accounts.find((a) => a.id === "acme")!.balanceCents, payer - 10_000);
  assert.equal(result.accounts.find((a) => a.id === "maya")!.balanceCents, payee + 10_000);
  assert.deepEqual(settleInvoice(result, "inv_seed_design", proof), result);
  assert.throws(() => settleInvoice(result, "inv_seed_design", { reference: "different", mode: "demo" }), /different payment reference/);
});

test("provider checkout reserves daily capacity and cash, but does not post a receipt", () => {
  let state = authorized();
  state = applyAction(state, { type: "update_policy", accountId: "acme", policy: { autoApproveCents: 5_000, dailyLimitCents: 15_000, allowedRails: ["stripe"] } });
  state = markProcessing(state, "inv_seed_design", { reference: "cs_test_1", paymentUrl: "https://checkout.stripe.com/test", mode: "stripe-test" });
  assert.equal(state.receipts.length, 2);
  assert.equal(state.invoices.find((i) => i.id === "inv_seed_design")!.status, "processing");
  state = applyAction(state, { type: "run_demo" });
  const next = state.invoices.at(-1)!;
  assert.throws(() => applyAction(state, { type: "approve", invoiceId: next.id }), /daily spending limit/);
  assert.throws(() => applyAction(state, { type: "reset" }), /pending provider payments/);
  assert.throws(() => applyAction(state, { type: "reject", invoiceId: "inv_seed_design" }), /processing/);
});

test("Stripe settlement requires matching pending provider evidence", () => {
  const base = authorized();
  assert.throws(() => settleInvoice(base, "inv_seed_design", { reference: "cs_test_missing", mode: "stripe-test" }), /existing pending checkout/);
  const pending = markProcessing(base, "inv_seed_design", { reference: "cs_test_verified", paymentUrl: "https://checkout.stripe.com/test", mode: "stripe-test" });
  assert.throws(() => settleInvoice(pending, "inv_seed_design", { reference: "cs_test_forged", mode: "stripe-test" }), /does not match/);
  const paid = settleInvoice(pending, "inv_seed_design", { reference: "cs_test_verified", mode: "stripe-test" });
  assert.equal(paid.invoices.find((i) => i.id === "inv_seed_design")!.status, "paid");
});

test("confirmed pending provider settlements reconcile after a subsequent policy change", () => {
  let state = markProcessing(authorized(), "inv_seed_design", { reference: "cs_test_reserved", paymentUrl: "https://checkout.stripe.com/test", mode: "stripe-test" });
  state = applyAction(state, { type: "update_policy", accountId: "acme", policy: { autoApproveCents: 0, dailyLimitCents: 0, allowedRails: [] } });
  const settled = settleInvoice(state, "inv_seed_design", { reference: "cs_test_reserved", mode: "stripe-test" });
  assert.equal(settled.receipts.at(-1)!.reference, "cs_test_reserved");
});

test("invoice inputs reject non-integer amounts, self-payment, unknown rails, and empty descriptions", () => {
  const base = { type: "create_invoice" as const, from: "maya", to: "acme", description: "Design", amountCents: 1000, rail: "stripe" as const };
  for (const cents of [-1, 0, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => applyAction(createInitialState(), { ...base, amountCents: cents }), /whole number of cents/);
  }
  assert.throws(() => applyAction(createInitialState(), { ...base, to: "maya" }), /different sender/);
  assert.throws(() => applyAction(createInitialState(), { ...base, description: "  " }), /description/);
  assert.throws(() => applyAction(createInitialState(), { ...base, rail: "other" as "stripe" }), /payment rail/);
});

test("spending cannot consume money reserved by another provider checkout", () => {
  let state = authorized();
  state.accounts.find((a) => a.id === "acme")!.balanceCents = 15_000;
  state = markProcessing(state, "inv_seed_design", { reference: "cs_test_reserve", paymentUrl: "https://checkout.stripe.com/test", mode: "stripe-test" });
  state = applyAction(state, { type: "run_demo" });
  assert.throws(() => applyAction(state, { type: "approve", invoiceId: state.invoices.at(-1)!.id }), /insufficient available funds/);
});

test("duplicate provider references cannot settle two invoices", () => {
  let state: MeshState = settleInvoice(authorized(), "inv_seed_design", { reference: "demo_unique", mode: "demo" });
  state = applyAction(state, { type: "run_demo" });
  const id = state.invoices.at(-1)!.id;
  state = applyAction(state, { type: "approve", invoiceId: id });
  assert.throws(() => settleInvoice(state, id, { reference: "demo_unique", mode: "demo" }), /already linked/);
});
