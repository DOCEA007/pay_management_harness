import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { applyAction, markProcessing, settleInvoice, validatePaymentPolicy } from "@/lib/mesh/engine";
import { createStripeCheckout, enrichAgentMessages, integrationStatus, IntegrationError, interpretRequest, verifyStripeCheckout } from "@/lib/mesh/integrations";
import { sessionFor, SESSION_COOKIE, withWorkspace } from "@/lib/mesh/store";
import { RequestError, validateAction } from "@/lib/mesh/validation";
import type { MeshResponse, MeshState } from "@/lib/mesh/types";

export const maxDuration = 60;
const limits = new Map<string, { count: number; until: number }>();

function response(payload: MeshResponse | { error: string }, session: ReturnType<typeof sessionFor>, request: Request, status = 200) {
  const result = NextResponse.json(payload, { status, headers: { "Cache-Control": "no-store" } });
  if (session.fresh) result.cookies.set(SESSION_COOKIE, session.id, { httpOnly: true, secure: new URL(request.url).protocol === "https:", sameSite: "strict", path: "/", maxAge: 60 * 60 * 24 * 30 });
  return result;
}

export async function GET(request: Request) {
  const session = sessionFor(request);
  try {
    return await withWorkspace(session.id, (state) => ({ state, result: response({ state, integrations: integrationStatus() }, session, request) }));
  } catch { return response({ error: "Could not open workspace storage. Check the server data directory." }, session, request, 500); }
}

function financeSummary(state: MeshState, accountId: string): string {
  const owner = state.accounts.find((account) => account.id === accountId);
  if (!owner) throw new RequestError("Unknown account.");
  const owed = state.invoices.filter((invoice) => invoice.to === accountId && !["paid", "rejected"].includes(invoice.status));
  const incoming = state.invoices.filter((invoice) => invoice.from === accountId && !["paid", "rejected"].includes(invoice.status));
  const amount = (sum: number) => `$${(sum / 100).toFixed(2)}`;
  return `${owner.name}: ${amount(owner.balanceCents)} demo balance. ${owed.length} unpaid outgoing invoice(s); ${incoming.length} unpaid incoming invoice(s). Your automatic approval limit is ${amount(owner.policy.autoApproveCents)} and daily cap is ${amount(owner.policy.dailyLimitCents)}. USD and USDC invoice totals are tracked separately in the ledger.`;
}

export async function POST(request: Request) {
  const session = sessionFor(request);
  try {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) throw new RequestError("Cross-origin workspace actions are not allowed.", 403);
    if (!request.headers.get("content-type")?.includes("application/json")) throw new RequestError("Use application/json.", 415);
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > 16_000) throw new RequestError("Request is too large.", 413);
    let input: unknown;
    try { input = JSON.parse(raw); } catch { throw new RequestError("Invalid JSON."); }
    const action = validateAction(input);
    const now = Date.now();
    for (const [key, value] of limits) if (value.until < now) limits.delete(key);
    const rate = limits.get(session.id) ?? { count: 0, until: now + 60_000 };
    if (++rate.count > 40) throw new RequestError("Too many actions. Try again in a minute.", 429);
    limits.set(session.id, rate);

    return await withWorkspace(session.id, async (previous) => {
      if (previous.invoices.length > 500 && ["create_invoice", "run_demo", "message"].includes(action.type)) throw new RequestError("This demo workspace is full. Export your ledger, then reset it.", 409);
      let state = previous;
      let notice: string | undefined;
      const integrations = integrationStatus();
      if (action.type === "message") {
        if (!state.accounts.some((account) => account.id === action.accountId)) throw new RequestError("Unknown account.");
        if (/\b(summary|balance|overview|spent|receipt|expenses|owe|owing|budget)\b/i.test(action.text) && !/\b(invoice|bill)\b/i.test(action.text)) {
          notice = financeSummary(state, action.accountId);
        } else if (integrations.llm === "shroud") {
          const interpreted = validateAction(await interpretRequest(action.text, action.accountId, state));
          if (interpreted.type !== "create_invoice") throw new RequestError("The assistant can draft invoices. Payment authorization uses the invoice approval controls.");
          state = applyAction(state, interpreted);
          notice = "Your agent drafted an invoice. Review it, then start the agent negotiation.";
        } else {
          // Predictable offline commands demonstrate the harness without pretending to be an LLM.
          const amount = action.text.match(/(?:\$\s*|\b(?:USD|USDC)\s*)(\d+(?:\.\d{1,2})?)(?![\d.])|\b(\d+(?:\.\d{1,2})?)\s*(?:USD|USDC)\b/i);
          const counterparty = state.accounts.find((account) => account.id !== action.accountId && (action.text.toLowerCase().includes(account.name.split(" ")[0].toLowerCase()) || action.text.toLowerCase().includes(account.name.toLowerCase())));
          if (/\b(invoice|bill|pay|send|charge)\b/i.test(action.text) && amount && counterparty) {
            const collect = /\b(invoice|bill|charge)\s+/i.test(action.text) && !/^\s*(pay|settle)\b/i.test(action.text);
            const requested = Math.round(Number(amount[1] ?? amount[2]) * 100);
            state = applyAction(state, { type: "create_invoice", from: collect ? action.accountId : counterparty.id, to: collect ? counterparty.id : action.accountId, amountCents: requested, description: action.text.slice(0, 300), rail: /\b(USDC|crypto)\b/i.test(action.text) ? "crypto" : "stripe" });
            notice = "Invoice drafted in demo mode. Review it and start the agent negotiation.";
          } else if (/\b(demo|design)\b/i.test(action.text)) {
            state = applyAction(state, { type: "run_demo" });
            notice = "The agents checked a $120 invoice against a $100 quote and agreed on the correction. Open the newest invoice to review.";
          } else {
            notice = `${financeSummary(state, action.accountId)} Try “Invoice Acme $120 for design work”, or connect Shroud for flexible requests. Payments are authorized from the invoice panel.`;
          }
        }
      } else if (action.type === "pay") {
        const invoice = state.invoices.find((item) => item.id === action.invoiceId);
        if (!invoice) throw new RequestError("Invoice not found.", 404);
        if (invoice.status === "paid") notice = "This invoice is already settled. No second payment was made.";
        else if (invoice.status === "processing") notice = "A checkout is already open. Use the payment link, then check payment status.";
        else if (invoice.status !== "approved") throw new RequestError("Approve the negotiated invoice before paying.", 409);
        else if (invoice.rail === "stripe" && integrations.stripe === "stripe-test") {
          // Check policy and reserve eligibility before making any provider request.
          validatePaymentPolicy(state, invoice);
          const checkout = await createStripeCheckout(invoice, new URL(request.url).origin);
          state = markProcessing(state, invoice.id, checkout);
          notice = "Stripe sandbox checkout created. Complete the test payment, then check payment status.";
        } else {
          state = settleInvoice(state, invoice.id, { reference: `demo_${randomUUID()}`, mode: "demo" });
          notice = "Demo payment settled and both ledgers reconciled. No real funds moved.";
        }
      } else if (action.type === "refresh_payment") {
        const invoice = state.invoices.find((item) => item.id === action.invoiceId);
        if (!invoice) throw new RequestError("Invoice not found.", 404);
        if (invoice.status === "paid") notice = "Payment is confirmed and reconciled.";
        else if (invoice.status !== "processing" || invoice.paymentMode !== "stripe-test") throw new RequestError("No Stripe sandbox payment is pending.", 409);
        else {
          const proof = await verifyStripeCheckout(invoice);
          if (proof) { state = settleInvoice(state, invoice.id, proof); notice = "Stripe confirmed the payment. Both ledgers are reconciled."; }
          else notice = "Stripe has not confirmed payment yet. Complete the sandbox checkout and check again.";
        }
      } else {
        state = applyAction(state, action);
        if (action.type === "run_demo") notice = "The agents negotiated $120 down to the agreed $100. Review and approve the newest invoice.";
        if (["run_demo", "negotiate"].includes(action.type) && integrations.llm === "shroud") {
          const invoiceId = "invoiceId" in action ? action.invoiceId : state.invoices.at(-1)?.id;
          if (invoiceId) {
            try { state = await enrichAgentMessages(state, invoiceId); }
            catch { notice = "The deterministic workflow completed. Shroud commentary is unavailable; check your agent configuration."; }
          }
        }
      }
      return { state, result: response({ state, integrations, notice }, session, request) };
    });
  } catch (error) {
    const status = error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : 500;
    const message = error instanceof IntegrationError ? error.message : status >= 500 ? "The action could not complete. Check server storage and 1Claw integration configuration, then retry." : error instanceof Error ? error.message : "Invalid request.";
    return response({ error: message }, session, request, status);
  }
}
