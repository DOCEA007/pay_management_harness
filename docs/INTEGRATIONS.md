# 1Claw and Stripe sandbox integration

The application runs completely in demo mode by default. Integration badges distinguish configured Shroud, Stripe sandbox, and simulated crypto routes. Configured status is not a remote health check.

## Shroud

Run `npm run setup` in the project directory. This is the supplied starter's interactive bootstrap. The human key is used during setup, the provider credential is stored in 1Claw, and the app keeps only the encrypted scoped `ONECLAW_AGENT_KEY` in the format `agent_id:ocv_…`. Start with `npm run dev` so dotenvx decrypts it.

When configuration is complete, `lib/oneclaw.ts` creates an OpenAI-compatible model pointing at 1Claw Shroud. `interpretRequest` permits only an invoice proposal. `enrichAgentMessages` sends separate bounded buyer and seller advisory calls. Errors produce a generic actionable message and never include the raw provider response.

## Stripe sandbox binding

The Stripe API key never belongs in this repository or its environment. Configure the following through the human-controlled 1Claw dashboard or its administrative API:

1. Create a Stripe **sandbox restricted key** with permissions sufficient to read balance and create/read Checkout Sessions and the associated price/product objects used by inline `price_data`.
2. Store it as a vault secret such as `integrations/stripe-test`. Store a bearer credential object if required by your binding configuration; the 1Claw binding resolves it server-side.
3. On the same scoped agent used by LedgerMesh, enable Execution Intents. This requires a supported 1Claw plan; see the current 1Claw documentation.
4. Create an HTTP binding named `stripe-test` with `base_url: https://api.stripe.com`, `auth_type: bearer`, and `credential_source: {type: vault_ref, vault_id: YOUR_VAULT_ID, path: integrations/stripe-test}`. Grant only the necessary policy access to that reference.
5. Limit `allowed_hosts` to `api.stripe.com`. Limit `allowed_paths` to `/v1/balance`, `/v1/checkout/sessions`, and `/v1/checkout/sessions/*`. Allow request headers `accept`, `content-type`, and `idempotency-key`. Apply timeouts and request limits.
6. Set the **non-secret** app setting `ONECLAW_STRIPE_BINDING=stripe-test` and restart the server. It may be provided in the shell; do not put the Stripe key beside it.

Example binding configuration, with no credential material:

```json
{
  "name": "stripe-test",
  "binding_type": "http",
  "config": {
    "base_url": "https://api.stripe.com",
    "auth_type": "bearer"
  },
  "credential_source": {
    "type": "vault_ref",
    "vault_id": "YOUR_VAULT_ID",
    "path": "integrations/stripe-test"
  },
  "guardrails": {
    "allowed_hosts": ["api.stripe.com"],
    "allowed_paths": ["/v1/balance", "/v1/checkout/sessions", "/v1/checkout/sessions/*"],
    "allowed_request_headers": ["accept", "content-type", "idempotency-key"],
    "max_duration_ms": 10000,
    "max_requests_per_minute": 20
  }
}
```

The adapter exchanges the scoped key at `POST /v1/auth/agent-token`, then calls `POST /v1/agents/{agent_id}/execute` with the configured binding. It does not fetch the Stripe secret.

### Form forwarding compatibility

Stripe v1 Checkout requires `application/x-www-form-urlencoded`, not a JSON object. The adapter supplies a URL-encoded string in `params.body` with the correct Content-Type. The public 1Claw OpenAPI schema intentionally leaves execution parameters untyped, and the available examples do not establish raw form forwarding behavior for every deployed executor version. **Validate this against your own sandbox binding before presenting the external integration as working.** If your executor JSON-serializes strings instead of forwarding raw form bodies, checkout creation will fail: enable form-body support in the executor or adapt `stripeRequest` to the supported documented encoding. There is no silent fallback to simulated settlement after a provider failure.

No credentialed external Stripe/1Claw smoke test has been performed merely by building this repository. The local demo requires none.

### Sandbox walkthrough

1. Run and approve a Stripe invoice in LedgerMesh.
2. Initiate payment. First, the adapter reads `/v1/balance` and requires `livemode: false`. It then creates a Checkout Session with an invoice-specific idempotency key and metadata.
3. Open the returned Stripe Checkout page. Use a Stripe sandbox card such as `4242 4242 4242 4242`, a future expiration date, and any valid test CVC.
4. Return to LedgerMesh and choose **Check payment status** in the invoice panel.
5. The server retrieves the session. Only `status: complete`, `payment_status: paid`, `livemode: false`, exact invoice amount/currency, exact session reference, and matching payer/payee metadata allow reconciliation.

Returning to `?payment=success` does not mark an invoice paid. An unpaid or expired session produces no ledger entries. Checkout payment is a merchant collection flow, not arbitrary person-to-person bank access. This prototype's one binding represents one demonstration merchant account; production needs a real provider-account mapping per seller.

## Crypto route

The crypto option currently demonstrates USDC-denominated agent agreement and simulated settlement. It does not generate signing keys, submit Intents, send x402 payments, or broadcast on a testnet/mainnet. A future adapter can use 1Claw signing/payment capabilities, but must bind actual counterpart wallets and verify chain settlement before posting the ledger.

## Non-secret server settings

| Setting | Purpose |
| --- | --- |
| `ONECLAW_STRIPE_BINDING` | Explicit opt-in binding name/ID for Stripe sandbox |
| `ONECLAW_BASE_URL` | Optional 1Claw API base; defaults to `https://api.1claw.co` |
| `ONECLAW_SHROUD_URL` | Optional Shroud base from the original starter |
| `LEDGERMESH_DATA_DIR` | Persistent local workspace storage directory |

The only app credential is `ONECLAW_AGENT_KEY`. Other project configuration, including provider/model identifiers, lives in `1claw.config.json` after setup.

## Sources

- [1Claw for AI](https://1claw.co/for-ai)
- [1Claw API schema](https://api.1claw.co/openapi.json)
- [1Claw execution-intents example](https://github.com/1clawAI/1claw-examples/tree/main/execution-intents)
- [Stripe Checkout creation](https://docs.stripe.com/api/checkout/sessions/create)
- [Stripe API v1 form encoding](https://docs.stripe.com/api)
- [Stripe sandbox testing](https://docs.stripe.com/testing)
