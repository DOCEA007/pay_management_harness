import type { MeshAction, Policy, Rail } from "./types";

export class RequestError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RequestError("Expected a JSON object.");
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new RequestError(`Invalid ${field}.`);
  return value.trim();
}
function cents(value: unknown, field: string, zero = false): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value > 100_000_000) throw new RequestError(`${field} must be a whole number of cents${zero ? ", zero or greater" : " greater than zero"}.`);
  return value;
}
function rail(value: unknown): Rail {
  if (value !== "stripe" && value !== "crypto") throw new RequestError("Choose Stripe or crypto.");
  return value;
}

export function validateAction(value: unknown): MeshAction {
  const input = record(value);
  switch (input.type) {
    case "reset": return { type: "reset" };
    case "run_demo": return { type: "run_demo", ...(input.rail === undefined ? {} : { rail: rail(input.rail) }) };
    case "create_invoice": return {
      type: "create_invoice", from: text(input.from, "seller"), to: text(input.to, "payer"),
      description: text(input.description, "description", 300), amountCents: cents(input.amountCents, "Amount"),
      rail: rail(input.rail), ...(input.agreedAmountCents === undefined ? {} : { agreedAmountCents: cents(input.agreedAmountCents, "Agreed amount") }),
    };
    case "negotiate": case "approve": case "reject": case "pay": case "refresh_payment":
      return { type: input.type, invoiceId: text(input.invoiceId, "invoice ID") };
    case "message": return { type: "message", text: text(input.text, "request", 2000), accountId: text(input.accountId, "account") };
    case "update_policy": {
      const policy = record(input.policy);
      if (!Array.isArray(policy.allowedRails) || policy.allowedRails.length > 2) throw new RequestError("Invalid payment routes.");
      const rails = [...new Set(policy.allowedRails.map(rail))];
      const validated: Policy = { autoApproveCents: cents(policy.autoApproveCents, "Automatic approval limit", true), dailyLimitCents: cents(policy.dailyLimitCents, "Daily limit", true), allowedRails: rails };
      if (validated.autoApproveCents > validated.dailyLimitCents) throw new RequestError("Automatic approval limit cannot exceed the daily limit.");
      return { type: "update_policy", accountId: text(input.accountId, "account"), policy: validated };
    }
    default: throw new RequestError("Unknown workspace action.");
  }
}
