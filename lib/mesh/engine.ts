import type { Account, AgentMessage, Invoice, MeshAction, MeshState, Policy, Rail, SettlementProof } from "./types";

export class DomainError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = "DomainError"; }
}

const timestamp = () => new Date().toISOString();
const uid = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
const money = (cents: number, currency: string) => `${(cents / 100).toFixed(2)} ${currency}`;

function amount(value: number, label: string, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new DomainError(`${label} must be ${allowZero ? "a non-negative" : "a positive"} whole number of cents.`);
  }
}

function account(state: MeshState, id: string): Account {
  const result = state.accounts.find((a) => a.id === id);
  if (!result) throw new DomainError("Account not found.", 404);
  return result;
}

function invoice(state: MeshState, id: string): Invoice {
  const result = state.invoices.find((i) => i.id === id);
  if (!result) throw new DomainError("Invoice not found.", 404);
  return result;
}

function audit(state: MeshState, action: string, detail: string, invoiceId?: string) {
  state.audit.push({ id: uid("evt"), action, detail, invoiceId, createdAt: timestamp() });
}

function say(state: MeshState, item: Invoice, from: string, to: string, kind: AgentMessage["kind"], text: string) {
  state.messages.push({ id: uid("msg"), invoiceId: item.id, from, to, kind, text, createdAt: timestamp(), engine: "demo" });
}

function validateRail(rail: Rail) {
  if (rail !== "stripe" && rail !== "crypto") throw new DomainError("Choose Stripe or crypto as the payment rail.");
}

function validatePolicy(policy: Policy) {
  if (!policy || typeof policy !== "object") throw new DomainError("A spending policy is required.");
  amount(policy.autoApproveCents, "Automatic approval limit", true);
  amount(policy.dailyLimitCents, "Daily spending limit", true);
  if (policy.autoApproveCents > policy.dailyLimitCents) throw new DomainError("Automatic approval cannot exceed the daily spending limit.");
  if (!Array.isArray(policy.allowedRails) || policy.allowedRails.length > 2 || new Set(policy.allowedRails).size !== policy.allowedRails.length) {
    throw new DomainError("Allowed rails must be a unique list of Stripe and/or crypto.");
  }
  policy.allowedRails.forEach(validateRail);
}

/** Outstanding provider payments reserve funds; settled payments debit the actual balance. */
export function validatePaymentPolicy(state: MeshState, item: Invoice) {
  const payer = account(state, item.to);
  amount(item.amountCents, "Invoice amount");
  if (!payer.policy.allowedRails.includes(item.rail)) throw new DomainError(`${payer.name}'s policy does not allow ${item.rail} payments.`, 409);
  const today = timestamp().slice(0, 10);
  let dailySpend = 0;
  let reservations = 0;
  for (const other of state.invoices) {
    if (other.id === item.id || other.to !== payer.id) continue;
    if (other.status === "processing") {
      reservations += other.amountCents;
      dailySpend += other.amountCents;
    } else if (other.status === "paid") {
      const receipt = state.receipts.find((r) => r.id === other.receiptId);
      if (receipt?.settledAt.slice(0, 10) === today) dailySpend += other.amountCents;
    }
  }
  if (!Number.isSafeInteger(dailySpend + item.amountCents) || dailySpend + item.amountCents > payer.policy.dailyLimitCents) {
    throw new DomainError(`This payment exceeds ${payer.name}'s remaining daily spending limit.`, 409);
  }
  if (!Number.isSafeInteger(reservations + item.amountCents) || reservations + item.amountCents > payer.balanceCents) {
    throw new DomainError(`${payer.name} has insufficient available funds after pending payments.`, 409);
  }
}

function createInvoice(state: MeshState, action: Extract<MeshAction, { type: "create_invoice" }>): Invoice {
  account(state, action.from);
  account(state, action.to);
  if (action.from === action.to) throw new DomainError("An invoice needs different sender and recipient accounts.");
  validateRail(action.rail);
  amount(action.amountCents, "Invoice amount");
  const agreed = action.agreedAmountCents ?? action.amountCents;
  amount(agreed, "Agreed quote");
  if (typeof action.description !== "string" || !action.description.trim() || action.description.trim().length > 300) {
    throw new DomainError("Add an invoice description between 1 and 300 characters.");
  }
  if (state.invoices.length >= 500) throw new DomainError("This demo workspace has reached its invoice limit. Export your records and reset the demo.", 409);
  const item: Invoice = {
    id: uid("inv"), number: `LM-${String(1001 + state.invoices.length).padStart(4, "0")}`,
    from: action.from, to: action.to, description: action.description.trim(),
    amountCents: action.amountCents, originalAmountCents: action.amountCents,
    agreedAmountCents: agreed, currency: action.rail === "crypto" ? "USDC" : "USD",
    rail: action.rail, status: "draft", createdAt: timestamp(),
    dueAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  };
  state.invoices.push(item);
  audit(state, "invoice.created", `${item.number}: ${money(item.amountCents, item.currency)} requested for ${item.description}.`, item.id);
  say(state, item, item.from, item.to, "request", `${account(state, item.to).agentName}, please review ${item.number}: ${money(item.amountCents, item.currency)} for ${item.description}. The recorded quote is ${money(agreed, item.currency)}.`);
  return item;
}

function negotiate(state: MeshState, item: Invoice) {
  if (item.status !== "draft" && item.status !== "negotiating") throw new DomainError("Only a draft invoice can enter negotiation.", 409);
  item.status = "negotiating";
  const payer = account(state, item.to);
  const seller = account(state, item.from);
  say(state, item, payer.id, seller.id, "verification", `I matched ${item.number} to the recorded agreement for ${item.description}. The agreed amount is ${money(item.agreedAmountCents, item.currency)}.`);
  if (item.amountCents !== item.agreedAmountCents) {
    say(state, item, payer.id, seller.id, "negotiation", `The invoice asks for ${money(item.amountCents, item.currency)}, which differs from our quote. Please correct it to ${money(item.agreedAmountCents, item.currency)}.`);
    item.amountCents = item.agreedAmountCents;
    say(state, item, seller.id, payer.id, "negotiation", `Confirmed. I corrected ${item.number} to ${money(item.amountCents, item.currency)} to match the agreement. No payment has been initiated.`);
    audit(state, "invoice.corrected", `Both agents accepted the recorded quote of ${money(item.amountCents, item.currency)}.`, item.id);
  } else {
    say(state, item, seller.id, payer.id, "negotiation", "Confirmed: the invoice and recorded agreement match. Ready for your payment policy check.");
  }
  item.status = "awaiting_approval";
  let policyFailure: string | undefined;
  try { validatePaymentPolicy(state, item); } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    policyFailure = error.message;
  }
  if (policyFailure) {
    say(state, item, payer.id, seller.id, "policy", `Payment is blocked by the current policy: ${policyFailure} The owner must resolve this before authorization.`);
    audit(state, "policy.blocked", policyFailure, item.id);
  } else if (item.amountCents <= payer.policy.autoApproveCents) {
    item.status = "approved";
    say(state, item, payer.id, seller.id, "policy", `The amount is within my owner's ${money(payer.policy.autoApproveCents, item.currency)} automatic approval limit. Authorized under the existing policy; settlement is a separate step.`);
    audit(state, "payment.auto_authorized", "Recorded agreement and current spending policy passed. Payment is authorized but has not settled.", item.id);
  } else {
    say(state, item, payer.id, seller.id, "policy", `${money(item.amountCents, item.currency)} exceeds my owner's ${money(payer.policy.autoApproveCents, item.currency)} automatic approval limit. I requested owner approval before payment.`);
    audit(state, "payment.approval_requested", `${payer.name} must approve ${item.number}.`, item.id);
  }
}

export function applyAction(input: MeshState, action: MeshAction): MeshState {
  if (!action || typeof action !== "object" || typeof action.type !== "string") throw new DomainError("Invalid workspace action.");
  if (action.type === "reset") {
    if (input.invoices.some((i) => i.status === "processing")) throw new DomainError("Finish pending provider payments before resetting this workspace.", 409);
    return createInitialState();
  }
  const state = structuredClone(input);
  switch (action.type) {
    case "run_demo": {
      const item = createInvoice(state, { type: "create_invoice", from: "maya", to: "acme", description: "Brand identity design · milestone 01", amountCents: 12_000, agreedAmountCents: 10_000, rail: action.rail ?? "stripe" });
      negotiate(state, item);
      break;
    }
    case "create_invoice": createInvoice(state, action); break;
    case "negotiate": negotiate(state, invoice(state, action.invoiceId)); break;
    case "approve": {
      const item = invoice(state, action.invoiceId);
      if (item.status !== "awaiting_approval") throw new DomainError("Only an invoice awaiting approval can be authorized.", 409);
      validatePaymentPolicy(state, item);
      item.status = "approved";
      say(state, item, item.to, item.from, "authorization", `My owner approved ${money(item.amountCents, item.currency)} for ${item.number}. The rail and daily budget checks passed. Ready to initiate payment.`);
      audit(state, "payment.owner_authorized", `Owner authorized the exact amount ${money(item.amountCents, item.currency)} on ${item.rail}.`, item.id);
      break;
    }
    case "reject": {
      const item = invoice(state, action.invoiceId);
      if (!["draft", "negotiating", "awaiting_approval", "approved"].includes(item.status)) throw new DomainError("A processing, paid, or already rejected invoice cannot be rejected.", 409);
      item.status = "rejected";
      say(state, item, item.to, item.from, "authorization", `My owner declined ${item.number}. No payment will be initiated.`);
      audit(state, "invoice.rejected", "Owner declined the invoice before payment.", item.id);
      break;
    }
    case "update_policy": {
      const owner = account(state, action.accountId);
      validatePolicy(action.policy);
      owner.policy = structuredClone(action.policy);
      audit(state, "policy.updated", `${owner.name}: automatic approval ${(owner.policy.autoApproveCents / 100).toFixed(2)}, daily cap ${(owner.policy.dailyLimitCents / 100).toFixed(2)}, rails ${owner.policy.allowedRails.join(", ") || "none"}. Existing payments are rechecked before execution.`);
      break;
    }
    case "pay": case "refresh_payment": case "message": throw new DomainError("This action must be handled by the server's payment or assistant adapter.");
    default: throw new DomainError("Unknown workspace action.");
  }
  return state;
}

export function markProcessing(input: MeshState, invoiceId: string, proof: SettlementProof & { paymentUrl: string }): MeshState {
  const state = structuredClone(input);
  const item = invoice(state, invoiceId);
  if (item.status === "processing" && item.providerReference === proof.reference) return state;
  if (item.status !== "approved") throw new DomainError("Authorize this invoice before initiating payment.", 409);
  validatePaymentPolicy(state, item);
  if (!proof.reference || !proof.paymentUrl || proof.mode !== "stripe-test" || item.rail !== "stripe") throw new DomainError("A Stripe test checkout reference and URL are required.");
  item.status = "processing";
  item.providerReference = proof.reference;
  item.paymentUrl = proof.paymentUrl;
  item.paymentMode = proof.mode;
  say(state, item, item.to, item.from, "settlement", "Stripe test checkout is ready. Payment remains pending until the provider confirms settlement; no receipt or ledger entry has been posted.");
  audit(state, "payment.processing", `Waiting for verified payment confirmation for ${proof.reference}.`, item.id);
  return state;
}

/** Call only with proof returned by the server adapter, never with browser-submitted proof. */
export function settleInvoice(input: MeshState, invoiceId: string, proof: SettlementProof): MeshState {
  const state = structuredClone(input);
  const item = invoice(state, invoiceId);
  if (item.status === "paid") {
    const receipt = state.receipts.find((r) => r.id === item.receiptId);
    if (receipt?.reference !== proof.reference || receipt.mode !== proof.mode) throw new DomainError("This invoice has already settled under a different payment reference.", 409);
    return state;
  }
  if (item.status !== "approved" && item.status !== "processing") throw new DomainError("Only an authorized payment can settle.", 409);
  if (!proof.reference || proof.reference.length > 250 || !["demo", "stripe-test"].includes(proof.mode)) throw new DomainError("Valid settlement evidence is required.");
  if (state.receipts.some((r) => r.reference === proof.reference)) throw new DomainError("This payment reference is already linked to another invoice.", 409);
  if (item.status === "processing" && (item.providerReference !== proof.reference || item.paymentMode !== proof.mode)) throw new DomainError("Settlement proof does not match the pending payment.", 409);
  if (proof.mode === "stripe-test" && (item.status !== "processing" || item.rail !== "stripe")) throw new DomainError("Stripe settlement must match an existing pending checkout.", 409);
  if (item.status === "approved") validatePaymentPolicy(state, item);
  // A confirmed external payment must reconcile even if the owner changed policy after checkout.
  const payer = account(state, item.to);
  const payee = account(state, item.from);
  if (!Number.isSafeInteger(payee.balanceCents + item.amountCents)) throw new DomainError("Recipient balance exceeds the supported amount range.", 409);
  if (payer.balanceCents < item.amountCents) throw new DomainError("Insufficient balance to reconcile this payment.", 409);
  const at = timestamp();
  const receiptId = uid("rcpt");
  state.receipts.push({ id: receiptId, invoiceId: item.id, amountCents: item.amountCents, currency: item.currency, rail: item.rail, reference: proof.reference, settledAt: at, mode: proof.mode });
  payer.balanceCents -= item.amountCents;
  payee.balanceCents += item.amountCents;
  for (const line of [
    { accountId: payer.id, account: "expenses" as const, debitCents: item.amountCents, creditCents: 0 },
    { accountId: payer.id, account: "cash" as const, debitCents: 0, creditCents: item.amountCents },
    { accountId: payee.id, account: "cash" as const, debitCents: item.amountCents, creditCents: 0 },
    { accountId: payee.id, account: "revenue" as const, debitCents: 0, creditCents: item.amountCents },
  ]) state.ledger.push({ id: uid("line"), invoiceId: item.id, ...line, currency: item.currency, createdAt: at, receiptId });
  item.status = "paid";
  item.receiptId = receiptId;
  item.providerReference = proof.reference;
  item.paymentMode = proof.mode;
  say(state, item, payer.id, payee.id, "settlement", `${proof.mode === "demo" ? "Demo settlement recorded" : "Stripe sandbox confirmed payment"}: ${money(item.amountCents, item.currency)}. Reference ${proof.reference}.`);
  say(state, item, payee.id, payer.id, "reconciliation", `Receipt ${receiptId} is matched to ${item.number}. Both accounts have balanced ledger entries; the invoice is closed.`);
  audit(state, "payment.settled", `${proof.mode}: ${proof.reference}; receipt and balanced entries posted to both owners.`, item.id);
  return state;
}

export function createInitialState(): MeshState {
  let state: MeshState = {
    version: 1,
    accounts: [
      { id: "alex", name: "Alex Morgan", kind: "personal", initials: "AM", color: "violet", agentName: "Atlas", agentRole: "Personal finance", balanceCents: 852_400, policy: { autoApproveCents: 5_000, dailyLimitCents: 250_000, allowedRails: ["stripe", "crypto"] } },
      { id: "acme", name: "Acme Studio", kind: "business", initials: "AS", color: "blue", agentName: "Nova", agentRole: "Business accounting", balanceCents: 2_450_000, policy: { autoApproveCents: 5_000, dailyLimitCents: 500_000, allowedRails: ["stripe", "crypto"] } },
      { id: "maya", name: "Maya Chen", kind: "personal", initials: "MC", color: "orange", agentName: "Sage", agentRole: "Freelance finance", balanceCents: 428_000, policy: { autoApproveCents: 2_500, dailyLimitCents: 100_000, allowedRails: ["stripe", "crypto"] } },
    ],
    invoices: [], messages: [], ledger: [], receipts: [], audit: [],
  };
  const seeds: Array<{ id: string; from: string; to: string; description: string; cents: number; quote?: number; rail: Rail; status: "paid" | "awaiting_approval" | "draft"; daysAgo: number }> = [
    { id: "inv_seed_website", from: "maya", to: "acme", description: "Website refresh · final delivery", cents: 45_000, rail: "stripe", status: "paid", daysAgo: 3 },
    { id: "inv_seed_dinner", from: "maya", to: "alex", description: "Friday dinner · your share", cents: 4_200, rail: "crypto", status: "paid", daysAgo: 1 },
    { id: "inv_seed_subscription", from: "acme", to: "alex", description: "Workspace membership · November", cents: 8_900, rail: "stripe", status: "awaiting_approval", daysAgo: 0 },
    { id: "inv_seed_design", from: "maya", to: "acme", description: "Brand identity design · milestone 01", cents: 12_000, quote: 10_000, rail: "stripe", status: "draft", daysAgo: 0 },
  ];
  for (const seed of seeds) {
    const item = createInvoice(state, { type: "create_invoice", from: seed.from, to: seed.to, description: seed.description, amountCents: seed.cents, agreedAmountCents: seed.quote, rail: seed.rail });
    const oldId = item.id;
    item.id = seed.id;
    state.messages.filter((m) => m.invoiceId === oldId).forEach((m) => { m.invoiceId = item.id; });
    state.audit.filter((e) => e.invoiceId === oldId).forEach((e) => { e.invoiceId = item.id; });
    if (seed.status !== "draft") negotiate(state, item);
    if (seed.status === "paid") {
      // Seed data is explicitly simulated, never represented as a provider settlement.
      item.status = "approved";
      state = settleInvoice(state, item.id, { reference: `demo_seed_${seed.id}`, mode: "demo" });
    }
    const previous = new Date(Date.now() - seed.daysAgo * 86_400_000).toISOString();
    state.invoices.find((i) => i.id === seed.id)!.createdAt = previous;
    state.messages.filter((m) => m.invoiceId === seed.id).forEach((m) => { m.createdAt = previous; });
    state.audit.filter((e) => e.invoiceId === seed.id).forEach((e) => { e.createdAt = previous; });
    state.receipts.filter((r) => r.invoiceId === seed.id).forEach((r) => { r.settledAt = previous; });
    state.ledger.filter((l) => l.invoiceId === seed.id).forEach((l) => { l.createdAt = previous; });
  }
  audit(state, "workspace.initialized", "Demo workspace ready. Atlas, Nova, and Sage each represent a different owner. Seed balances and receipts are simulated.");
  return state;
}
