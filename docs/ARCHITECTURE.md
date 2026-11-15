# Architecture and protocol

LedgerMesh is a harness for finance agents representing distinct owners. The local workspace includes Alex Morgan, Acme Studio, and Maya Chen. Each has an agent identity, spending policy, and simulated available balance.

## Financial flow

```text
Owner request
    ↓
Draft invoice → buyer verification → seller correction to recorded quote
    ↓
Owner authorization or existing automatic-approval policy
    ↓
Payment adapter: demo settlement or optional Stripe sandbox Checkout
    ↓
Provider-confirmed settlement → receipt → both owners' ledgers
```

The default conversation is deterministic and labelled demo. When Shroud is configured, buyer and seller roles also produce separate advisory messages using bounded model requests. These messages cannot change the invoice, authorize payments, or write ledger entries. The same deterministic state machine checks all invoices, including drafts extracted by a model.

## State machine

| State | Permitted next step |
| --- | --- |
| `draft` | Negotiate or reject |
| `negotiating` | Verify recorded quote and determine authorization requirement |
| `awaiting_approval` | Owner approval after current policy checks, or rejection |
| `approved` | Payment initiation after policy is checked again, or rejection |
| `processing` | Provider verification; no receipt or ledger posting yet |
| `paid` | Terminal; repeated payment commands do not pay again |
| `rejected` | Terminal |

Negotiation corrects the amount to `agreedAmountCents`, which the user supplies as the recorded quote. That value is demonstration evidence, not proof of an independently signed agreement. Manual approval cannot override a disabled payment rail, insufficient simulated available funds, or the daily limit. In-flight provider payments reserve capacity. Policy changes affect subsequent authorization and initiation checks.

## Accounting

Amounts use positive integer cents. USD and USDC are distinct currencies; USDC is represented to two decimal places for the demo. It does not model token base units or exchange rates.

Each settlement creates exactly one receipt and these entries:

| Owner | Account | Debit | Credit |
| --- | --- | --- | --- |
| Buyer | Expenses | Invoice amount | 0 |
| Buyer | Cash | 0 | Invoice amount |
| Seller | Cash | Invoice amount | 0 |
| Seller | Revenue | 0 | Invoice amount |

The model cannot supply settlement proof. The server either creates clearly labelled demo proof or retrieves and verifies the Stripe sandbox Checkout Session. Browser return URLs and agent assertions never constitute settlement confirmation.

## API

`GET /api/mesh` returns `{state, integrations}` and establishes an HttpOnly, SameSite session cookie. `POST /api/mesh` accepts JSON actions and returns `{state, integrations, notice?}`. Requests are validated and same-origin browser requests are enforced. There is a per-session action limit.

| Action | Fields |
| --- | --- |
| `run_demo` | Optional `rail`: `stripe` or `crypto` |
| `create_invoice` | `from`, `to`, `description`, `amountCents`, optional `agreedAmountCents`, `rail` |
| `negotiate` | `invoiceId` |
| `approve` | `invoiceId` |
| `reject` | `invoiceId` |
| `pay` | `invoiceId` |
| `refresh_payment` | `invoiceId` |
| `update_policy` | `accountId`, `policy` with `autoApproveCents`, `dailyLimitCents`, `allowedRails` |
| `message` | `accountId`, `text` |
| `reset` | None; refused while provider payment is processing |

`GET /api/mesh/export?format=csv` downloads ledger entries. `format=json` exports the workspace record. Records are scoped by browser workspace session; owner views in that workspace are a demo convenience, not a permission boundary.

## Persistence and recovery

The server reads and writes one JSON file per workspace under `.data/ledgermesh`. A per-workspace queue serializes read/modify/write operations in one Node process. Writes use a temporary file and atomic rename. Files are not encrypted accounting storage and must remain on private local disk. Data and secrets are ignored by Git.

Stripe creation uses a deterministic idempotency key based on invoice ID and amount. This limits duplicate Checkout Session creation on immediate retry, including a crash between session creation and local persistence. The current prototype does not implement a webhook inbox, multi-process lock, long-term outbox recovery, recurring scheduler, signed agent federation, escrow, tax filing, or live crypto payments. These are extension points, not hidden dependencies of the demo.

## Extending the harness

Add a provider adapter that creates an intent and independently verifies settlement; keep the ledger and authorization checks in the engine. A Hermes runtime can call the same structured invoice actions through an authenticated wrapper. Production owner identity, verified counterparty discovery, and signed agreement messages should precede unrestricted external agent access.
