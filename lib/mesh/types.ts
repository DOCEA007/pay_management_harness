export type Currency = "USD" | "USDC";
export type Rail = "stripe" | "crypto";
export type InvoiceStatus = "draft" | "negotiating" | "awaiting_approval" | "approved" | "processing" | "paid" | "rejected";
export interface Policy { autoApproveCents: number; dailyLimitCents: number; allowedRails: Rail[]; }
export interface Account { id: string; name: string; kind: "personal" | "business"; initials: string; color: string; agentName: string; agentRole: string; balanceCents: number; policy: Policy; }
export interface AgentMessage { id: string; invoiceId: string; from: string; to: string; kind: "request" | "verification" | "negotiation" | "policy" | "authorization" | "settlement" | "reconciliation"; text: string; createdAt: string; engine: "demo" | "shroud"; }
export interface Invoice { id: string; number: string; from: string; to: string; description: string; amountCents: number; originalAmountCents: number; agreedAmountCents: number; currency: Currency; rail: Rail; status: InvoiceStatus; createdAt: string; dueAt: string; receiptId?: string; paymentUrl?: string; providerReference?: string; paymentMode?: "demo" | "stripe-test"; }
export interface LedgerEntry { id: string; invoiceId: string; accountId: string; account: "cash" | "revenue" | "expenses"; debitCents: number; creditCents: number; currency: Currency; createdAt: string; receiptId: string; }
export interface Receipt { id: string; invoiceId: string; amountCents: number; currency: Currency; rail: Rail; reference: string; settledAt: string; mode: "demo" | "stripe-test"; }
export interface AuditEvent { id: string; action: string; detail: string; createdAt: string; invoiceId?: string; }
export interface MeshState { version: 1; accounts: Account[]; invoices: Invoice[]; messages: AgentMessage[]; ledger: LedgerEntry[]; receipts: Receipt[]; audit: AuditEvent[]; }
export interface IntegrationStatus { llm: "demo" | "shroud"; stripe: "demo" | "stripe-test"; crypto: "demo"; storage: "local"; }
export interface MeshResponse { state: MeshState; integrations: IntegrationStatus; notice?: string; }
export type MeshAction =
  | { type: "run_demo"; rail?: Rail }
  | { type: "create_invoice"; from: string; to: string; description: string; amountCents: number; agreedAmountCents?: number; rail: Rail }
  | { type: "negotiate"; invoiceId: string }
  | { type: "approve" | "reject" | "pay" | "refresh_payment"; invoiceId: string }
  | { type: "update_policy"; accountId: string; policy: Policy }
  | { type: "reset" }
  | { type: "message"; text: string; accountId: string };
export interface SettlementProof { reference: string; mode: "demo" | "stripe-test"; }
