# LedgerMesh

**Your finance agent talks to their finance agent. They agree on what's owed, arrange payment, and reconcile both sides.**

A hackathon application for the 1Claw ecosystem: a personal finance agent harness connecting people, freelancers, and businesses. Built on the supplied 1Claw Next.js starter.

## Run locally

Requires Node.js 22 or newer.

```bash
npm install
npm run dev
```

Open [localhost:3000](http://localhost:3000). The complete demo runs without credentials. Each browser session gets its own workspace with three representative owners, invoices, spending policies, agent conversations, receipts, and a double-entry ledger. Demo payments move simulated balances only.

```bash
npm test
npm run typecheck
npm run build
```

With the dev server running, `npm run test:smoke` exercises the full invoice → approval → payment → reconciliation API workflow, exports, duplicate-payment handling, and workspace isolation.

## Try the story

1. Click **Run demo**. Maya's agent sends Acme an invoice for $120 against a recorded $100 quote.
2. Open the new invoice. The agents verify the quote, identify the discrepancy, and agree on a $100 correction.
3. Acme's policy routes the amount to owner approval. Review the conversation and approve it.
4. Initiate payment. In demo mode the harness settles simulated funds and reconciles both owners' books. With the optional Stripe sandbox binding, finish the test checkout and check payment status.
5. Open the ledger and export the entries. There is one receipt and four balanced ledger entries for the payment.

Also try creating an invoice, selecting the crypto demo rail, changing a spending policy, rejecting an invoice, filtering records, switching owner views, and requesting a finance summary from the assistant.

## What is implemented

- A compact finance workspace with invoice conversations, agent cards, ledger exports, and an expandable spending-policy editor.
- Per-owner finance agents with a structured request → verification → negotiation → authorization → settlement → reconciliation workflow.
- Amount correction against the recorded agreement, manual or policy-based authorization, spending caps, and pending-payment reservations.
- Server-side session isolation and durable local JSON storage, atomic writes, and serialized operations per workspace.
- Idempotent settlement, payment receipts, balanced entries in both owners' ledgers, audit history, and CSV/JSON exports.
- Stripe and USDC **demo** payment routes, both usable immediately.
- Optional real Stripe **sandbox** Checkout integration through 1Claw Execution Intents. Stripe credentials stay in the vault binding.
- Optional Shroud language interpretation for drafting invoices, plus separate buyer and seller advisory model calls. Financial state transitions remain enforced by code.

## Connect 1Claw

```bash
npm run setup
```

The original starter setup registers a scoped agent, configures Shroud, stores provider credentials in 1Claw, and saves only an encrypted `ONECLAW_AGENT_KEY` in the app environment. Restart the dev server afterwards. Do not add a Stripe key, LLM key, private wallet key, or human `1ck_` key to app env files. Never commit `.env.keys`.

With Shroud configured, the assistant can extract a draft invoice from requests such as “Invoice Acme $120 for brand design.” Buyer and seller advisory responses are marked as Shroud messages. The model cannot authorize a payment, execute a payment, or change owner policy. Without Shroud, the assistant uses limited, explicit demo commands and calculated summaries.

For Stripe sandbox configuration and its required form-body forwarding check, read [the integration guide](docs/INTEGRATIONS.md). Crypto settlement is currently simulated; the application does not broadcast blockchain transactions or claim to implement x402 settlement.

## Project map

| Area | Location |
| --- | --- |
| Dashboard and interactions | `components/mesh-dashboard.tsx` |
| Shared data and action protocol | `lib/mesh/types.ts` |
| Finance state machine and bookkeeping | `lib/mesh/engine.ts` |
| Server workspace persistence | `lib/mesh/store.ts` |
| Input validation | `lib/mesh/validation.ts` |
| Shroud and Stripe adapters | `lib/mesh/integrations.ts` |
| Workspace API | `app/api/mesh/route.ts` |
| Ledger export API | `app/api/mesh/export/route.ts` |
| Domain verification | `tests/engine.test.ts` |

See [architecture and protocol](docs/ARCHITECTURE.md) and [the demo script](docs/DEMO.md).

## Current scope

This is a runnable local hackathon project. Owner switching demonstrates multiple principals inside one browser workspace; it is not independent production identity or authentication. Negotiation uses the agreement recorded with the invoice, not a signed external contract. Agent messages are stored protocol records, not cryptographically authenticated inter-company messages.

Storage defaults to `.data/ledgermesh`, ignored by Git. Set the non-secret `LEDGERMESH_DATA_DIR` setting to change the directory. Use one Node process with a persistent writable disk. Multi-instance/serverless deployment requires replacing the file store with transactional shared storage. A production release also needs actual owner authentication, tenant/provider account mapping, provider event processing, and operational recovery for interrupted payments. An expired Stripe checkout is never reconciled as paid; pending provider payments must be resolved before demo reset.

## References

- [1Claw integration guide](https://1claw.co/for-ai)
- [1Claw execution-intents examples](https://github.com/1clawAI/1claw-examples/tree/main/execution-intents)
- [Stripe Checkout Session API](https://docs.stripe.com/api/checkout/sessions/create)
- [Stripe sandbox testing](https://docs.stripe.com/testing)
