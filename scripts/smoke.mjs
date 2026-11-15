import assert from "node:assert/strict";

const origin = process.env.LEDGERMESH_TEST_URL || "http://localhost:3000";
let cookie;
async function request(body, expected = 200) {
  const response = await fetch(`${origin}/api/mesh`, { method: body ? "POST" : "GET", headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json", Origin: origin } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
  const json = await response.json();
  assert.equal(response.status, expected, JSON.stringify(json));
  return json;
}

const initial = await request();
assert.ok(cookie?.startsWith("ledgermesh_session="));
assert.equal(initial.state.accounts.length, 3);
assert.equal(initial.integrations.crypto, "demo");
await request({ type: "pay", invoiceId: "inv_seed_design" }, 409);
let result = await request({ type: "run_demo", rail: "crypto" });
const invoice = result.state.invoices.at(-1);
assert.equal(invoice.status, "awaiting_approval");
assert.equal(invoice.amountCents, 10000);
assert.equal(invoice.originalAmountCents, 12000);
await request({ type: "approve", invoiceId: invoice.id });
result = await request({ type: "pay", invoiceId: invoice.id });
assert.equal(result.state.invoices.find((item) => item.id === invoice.id).status, "paid");
const lines = result.state.ledger.filter((item) => item.invoiceId === invoice.id);
assert.equal(lines.length, 4);
assert.equal(lines.reduce((total, line) => total + line.debitCents - line.creditCents, 0), 0);
const receipts = result.state.receipts.length;
// Simultaneous retries must serialize and leave exactly one receipt.
await Promise.all([request({ type: "pay", invoiceId: invoice.id }), request({ type: "pay", invoiceId: invoice.id })]);
result = await request();
assert.equal(result.state.receipts.length, receipts);
const csv = await fetch(`${origin}/api/mesh/export?format=csv`, { headers: { Cookie: cookie } });
assert.equal(csv.status, 200);
assert.ok((await csv.text()).includes(invoice.number));
const exported = await fetch(`${origin}/api/mesh/export?format=json`, { headers: { Cookie: cookie } });
assert.equal((await exported.json()).receipts.length, receipts);
await request({ type: "settle", invoiceId: invoice.id, reference: "fake" }, 400);
const forbidden = await fetch(`${origin}/api/mesh`, { method: "POST", headers: { Cookie: cookie, Origin: "https://unrelated.example", "Content-Type": "application/json" }, body: JSON.stringify({ type: "reset" }) });
assert.equal(forbidden.status, 403);
const separate = await fetch(`${origin}/api/mesh`);
assert.equal((await separate.json()).state.invoices.length, initial.state.invoices.length);
await request({ type: "reset" });
console.log("PASS: isolated persisted sessions, negotiation, approval, demo settlement, duplicate/concurrent payment protection, balanced ledgers, CSV/JSON exports, invalid actions, and origin checks.");
