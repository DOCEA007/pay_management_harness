import assert from "node:assert/strict";
import test from "node:test";
import { validateAction } from "../lib/mesh/validation";
import { ledgerCsv } from "../lib/mesh/export";
import { createInitialState } from "../lib/mesh/engine";

test("request validation does not accept browser settlement evidence or privileged operations", () => {
  for (const input of [null, [], "approve", { type: "settle", reference: "forged" }, { type: "grant_access" }, { type: "pay" }]) {
    assert.throws(() => validateAction(input));
  }
  assert.deepEqual(validateAction({ type: "pay", invoiceId: "inv_seed_design", reference: "forged", amountCents: 1 }), { type: "pay", invoiceId: "inv_seed_design" });
});

test("integer cents and bounded input are required at the HTTP boundary", () => {
  const input = { type: "create_invoice", from: "maya", to: "acme", description: "Design", amountCents: 100, rail: "stripe" };
  for (const value of ["100", 1.1, -1, 0, NaN, 100_000_001]) assert.throws(() => validateAction({ ...input, amountCents: value }));
  assert.throws(() => validateAction({ ...input, description: "x".repeat(501) }));
  assert.throws(() => validateAction({ type: "message", accountId: "alex", text: "x".repeat(2001) }));
});

test("spending policy shape rejects invalid routes and inverted caps", () => {
  const action = { type: "update_policy", accountId: "alex", policy: { autoApproveCents: 100, dailyLimitCents: 500, allowedRails: ["crypto"] } };
  assert.deepEqual(validateAction(action), action);
  assert.throws(() => validateAction({ ...action, policy: { ...action.policy, allowedRails: ["wire"] } }));
  assert.throws(() => validateAction({ ...action, policy: { ...action.policy, dailyLimitCents: 0 } }));
});

test("CSV export escapes quotes and prevents spreadsheet formulas in user-supplied names", () => {
  const state = createInitialState();
  state.accounts.find((account) => account.id === "maya")!.name = '=HYPERLINK("https://example.test")';
  const csv = ledgerCsv(state);
  assert.ok(csv.startsWith('"Entry","Invoice","Owner"'));
  assert.ok(csv.includes(`"'=HYPERLINK(""https://example.test"")"`));
  assert.equal(csv.split("\r\n").length, state.ledger.length + 1);
});
