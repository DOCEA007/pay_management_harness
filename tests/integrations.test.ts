import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createStripeCheckout, integrationStatus, verifyStripeCheckout } from "../lib/mesh/integrations";
import type { Invoice } from "../lib/mesh/types";

const fixtureInvoice: Invoice = {
  id: "inv_fixture", number: "LM-TEST", from: "maya", to: "acme",
  description: "Design milestone", amountCents: 10_000, originalAmountCents: 12_000,
  agreedAmountCents: 10_000, currency: "USD", rail: "stripe", status: "approved",
  createdAt: "2026-11-15T10:00:00.000Z", dueAt: "2026-11-22T10:00:00.000Z",
};

const fixtureSession = {
  id: "cs_test_fixture", object: "checkout.session", livemode: false,
  amount_total: 10_000, currency: "usd", client_reference_id: "inv_fixture",
  metadata: { ledger_mesh_invoice: "inv_fixture", payer: "acme", payee: "maya" },
  status: "open", payment_status: "unpaid", url: "https://checkout.stripe.com/c/pay/cs_test_fixture",
};

const pendingInvoice: Invoice = {
  ...fixtureInvoice, status: "processing", paymentMode: "stripe-test", providerReference: fixtureSession.id,
};

type Reply = { body: unknown; status?: number };
type RecordedCall = { url: string; init: RequestInit };

/** Every call is intercepted, including unexpected calls. This fixture cannot reach a remote service. */
function harness(t: TestContext, replies: Reply[]) {
  const keys = ["ONECLAW_AGENT_KEY", "ONECLAW_STRIPE_BINDING", "ONECLAW_BASE_URL"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.ONECLAW_AGENT_KEY = "dummy:ocv_test_fixture";
  process.env.ONECLAW_STRIPE_BINDING = "stripe-test-fixture";
  process.env.ONECLAW_BASE_URL = "https://fixture.invalid";
  const calls: RecordedCall[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const reply = replies[calls.length - 1];
    assert.ok(reply, `Unexpected fixture request ${String(url)}`);
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { "Content-Type": "application/json" } });
  });
  t.after(() => {
    t.mock.restoreAll();
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  return calls;
}

const auth: Reply = { body: { access_token: "fixture_access_token" } };
const sandbox: Reply = { body: { status: "completed", result: { object: "balance", livemode: false } } };
function execution(body: unknown): Reply { return { body: { status: "completed", result: body } }; }
function requestBody(call: RecordedCall): Record<string, unknown> { return JSON.parse(String(call.init.body)); }

test("a human, encrypted, or missing key never enables or calls the Stripe adapter", async (t) => {
  for (const credential of [undefined, "encrypted:fixture", "1ck_fixture", "dummy:not_an_agent_key"]) {
    await t.test(String(credential), async (inner) => {
      const calls = harness(inner, []);
      if (credential === undefined) delete process.env.ONECLAW_AGENT_KEY;
      else process.env.ONECLAW_AGENT_KEY = credential;
      assert.equal(integrationStatus().stripe, "demo");
      await assert.rejects(createStripeCheckout(fixtureInvoice, "https://app.example"), /not configured/);
      assert.equal(calls.length, 0);
    });
  }
});

test("checkout rejects unapproved, crypto, and invalid amount requests before any provider call", async (t) => {
  const calls = harness(t, []);
  for (const patch of [
    { status: "draft" as const }, { currency: "USDC" as const }, { rail: "crypto" as const },
    { amountCents: 0 }, { amountCents: 1.5 }, { amountCents: Number.MAX_SAFE_INTEGER + 1 },
  ]) await assert.rejects(createStripeCheckout({ ...fixtureInvoice, ...patch }, "https://app.example"));
  assert.equal(calls.length, 0);
});

test("a live Stripe binding is refused before a checkout session is created", async (t) => {
  const calls = harness(t, [auth, execution({ object: "balance", livemode: true })]);
  await assert.rejects(createStripeCheckout(fixtureInvoice, "https://app.example"), /sandbox key.*Live mode was refused/);
  assert.equal(calls.length, 2);
  const operation = requestBody(calls[1]);
  assert.equal((operation.params as Record<string, unknown>).path, "/v1/balance");
});

test("checkout uses scoped authentication, sandbox preflight, exact amount metadata, and a stable idempotency key", async (t) => {
  const calls = harness(t, [auth, sandbox, auth, execution(fixtureSession)]);
  const result = await createStripeCheckout(fixtureInvoice, "https://app.example/dashboard?ignored=true");
  assert.deepEqual(result, { reference: fixtureSession.id, paymentUrl: fixtureSession.url, mode: "stripe-test" });
  assert.equal(calls.length, 4);
  assert.equal(calls[0].url, "https://fixture.invalid/v1/auth/agent-token");
  assert.deepEqual(requestBody(calls[0]), { agent_id: "dummy", api_key: "ocv_test_fixture" });
  assert.equal(calls[1].url, "https://fixture.invalid/v1/agents/dummy/execute");
  assert.equal(new Headers(calls[1].init.headers).get("Authorization"), "Bearer fixture_access_token");
  const preflight = requestBody(calls[1]);
  assert.equal(preflight.binding, "stripe-test-fixture");
  assert.equal(preflight.intent_type, "http");
  assert.deepEqual((preflight.params as Record<string, unknown>).method, "GET");
  assert.deepEqual((preflight.params as Record<string, unknown>).path, "/v1/balance");
  const checkout = requestBody(calls[3]);
  assert.equal(checkout.binding, "stripe-test-fixture");
  const params = checkout.params as Record<string, unknown>;
  assert.equal(params.method, "POST");
  assert.equal(params.path, "/v1/checkout/sessions");
  assert.equal((params.headers as Record<string, string>)["Idempotency-Key"], "ledgermesh:inv_fixture:10000");
  assert.equal((params.headers as Record<string, string>)["Content-Type"], "application/x-www-form-urlencoded");
  const form = new URLSearchParams(String(params.body));
  assert.equal(form.get("line_items[0][price_data][unit_amount]"), "10000");
  assert.equal(form.get("line_items[0][price_data][currency]"), "usd");
  assert.equal(form.get("line_items[0][quantity]"), "1");
  assert.equal(form.get("client_reference_id"), fixtureInvoice.id);
  assert.equal(form.get("metadata[ledger_mesh_invoice]"), fixtureInvoice.id);
  assert.equal(form.get("metadata[payer]"), "acme");
  assert.equal(form.get("metadata[payee]"), "maya");
  assert.equal(form.get("success_url"), "https://app.example/?payment=success&invoice=inv_fixture");
  assert.equal(form.get("cancel_url"), "https://app.example/?payment=cancelled&invoice=inv_fixture");
  assert.equal(JSON.stringify(checkout).includes("ocv_test_fixture"), false);
});

test("checkout refuses a provider result with an altered amount or counterparty", async (t) => {
  for (const patch of [{ amount_total: 9999 }, { metadata: { ...fixtureSession.metadata, payee: "attacker" } }]) {
    await t.test(JSON.stringify(patch), async (inner) => {
      harness(inner, [auth, sandbox, auth, execution({ ...fixtureSession, ...patch })]);
      await assert.rejects(createStripeCheckout(fixtureInvoice, "https://app.example"), /do not match this invoice/);
    });
  }
});

test("checkout never returns a payment URL outside Stripe's HTTPS checkout host", async (t) => {
  for (const url of ["https://attacker.example/pay", "http://checkout.stripe.com/pay", "https://checkout.stripe.com.attacker.example/pay", "https://user:secret@checkout.stripe.com/pay"]) {
    await t.test(url, async (inner) => {
      harness(inner, [auth, sandbox, auth, execution({ ...fixtureSession, url })]);
      await assert.rejects(createStripeCheckout(fixtureInvoice, "https://app.example"), /unexpected payment destination/);
    });
  }
});

test("an unpaid or incomplete checkout returns no settlement proof", async (t) => {
  for (const patch of [
    { status: "open", payment_status: "unpaid" },
    { status: "complete", payment_status: "unpaid" },
    { status: "open", payment_status: "paid" },
  ]) {
    await t.test(JSON.stringify(patch), async (inner) => {
      harness(inner, [auth, execution({ ...fixtureSession, ...patch })]);
      assert.equal(await verifyStripeCheckout(pendingInvoice), null);
    });
  }
});

test("only a complete paid checkout matching the pending invoice returns settlement proof", async (t) => {
  const calls = harness(t, [auth, execution({ ...fixtureSession, status: "complete", payment_status: "paid" })]);
  assert.deepEqual(await verifyStripeCheckout(pendingInvoice), { reference: "cs_test_fixture", mode: "stripe-test" });
  const operation = requestBody(calls[1]);
  assert.equal((operation.params as Record<string, unknown>).method, "GET");
  assert.equal((operation.params as Record<string, unknown>).path, "/v1/checkout/sessions/cs_test_fixture");
});

test("verification rejects mismatched amount, currency, invoice, parties, reference, and live sessions", async (t) => {
  const patches = [
    { amount_total: 99_999 }, { currency: "eur" }, { client_reference_id: "another_invoice" },
    { metadata: { ...fixtureSession.metadata, ledger_mesh_invoice: "another_invoice" } },
    { metadata: { ...fixtureSession.metadata, payer: "alex" } },
    { metadata: { ...fixtureSession.metadata, payee: "alex" } },
    { id: "cs_test_different" }, { id: "cs_live_forbidden", livemode: true },
  ];
  for (const patch of patches) {
    await t.test(JSON.stringify(patch), async (inner) => {
      harness(inner, [auth, execution({ ...fixtureSession, status: "complete", payment_status: "paid", ...patch })]);
      await assert.rejects(verifyStripeCheckout(pendingInvoice), /do not match|different payment reference|sandbox Checkout Session/);
    });
  }
});

test("expired checkout is not reconciled as paid", async (t) => {
  harness(t, [auth, execution({ ...fixtureSession, status: "expired", payment_status: "unpaid" })]);
  await assert.rejects(verifyStripeCheckout(pendingInvoice), /expired.*not reconciled as paid/);
});

test("upstream HTTP and execution errors are redacted instead of echoing credential details", async (t) => {
  const secret = "sk_test_should_never_be_exposed";
  const failures: Reply[][] = [
    [auth, { status: 403, body: { error: `Binding contained ${secret}` } }],
    [auth, { body: { status: "failed", error: secret, result: {} } }],
    [auth, execution({ status_code: 401, body: { error: secret } })],
    [auth, execution({ error: { message: secret } })],
  ];
  for (let i = 0; i < failures.length; i++) {
    await t.test(`upstream failure ${i + 1}`, async (inner) => {
      harness(inner, failures[i]);
      await assert.rejects(verifyStripeCheckout(pendingInvoice), (error: Error) => {
        assert.equal(error.name, "Error");
        assert.equal(error.message.includes(secret), false);
        assert.ok(error.message.length > 10);
        return true;
      });
    });
  }
});

test("a 1Claw approval response remains pending instead of returning payment proof", async (t) => {
  harness(t, [auth, { status: 202, body: { approval_id: "fixture_approval", secret: "redacted_fixture" } }]);
  await assert.rejects(verifyStripeCheckout(pendingInvoice), /requires approval in its dashboard/);
});
