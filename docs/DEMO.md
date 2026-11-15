# Hackathon demo script

**Pitch:** “Every person and business gets a finance agent. Your agent talks to theirs, checks what is owed, arranges an authorized payment, and reconciles both sides. 1Claw supplies credential isolation and optional agent execution.”

## Three-minute walkthrough

**0:00 — The workspace.** Show the overview and connected owners: a person, a business, and a freelancer. Explain the demo badge and the configured integration badges. Default payments are simulated; only a configured Stripe sandbox uses an external payment provider.

**0:25 — A disagreement.** Click Run demo. Maya's agent invoices Acme $120 for a design milestone. Open the newest invoice. Acme's agent checks the recorded $100 quote and asks for correction. Maya's agent accepts. Show the original and agreed amounts and the ordered messages.

**1:10 — The owner decides.** The corrected amount exceeds Acme's automatic approval threshold, so the workflow waits. Approve the invoice. Explain that the hard daily cap and allowed payment rails still apply even after manual approval.

**1:35 — Payment.** Initiate a demo payment and show the receipt. If Stripe sandbox is configured and has been smoke-tested, use a test Checkout Session instead, complete its test payment, and check status. Do not describe a redirect or pending session as settlement.

**2:05 — Two books close together.** Show the ledger: payer expense and cash entries, seller cash and revenue entries, all linked to one receipt. Export CSV to demonstrate portable records.

**2:30 — The harness.** Open the Agents tab and expandable Spending policy panel. Explain that the product supports multiple owners and payment adapters. Show the crypto demo route as the next adapter boundary, and Shroud advisory messages if configured. The model proposes and explains; the state machine authorizes and reconciles.

## Optional second scenario

Set an owner's policy to disable crypto. Create a USDC demo invoice addressed to that owner and negotiate it. The harness records the policy block and refuses authorization/payment. Restore the rail and continue, or reject the invoice. This demonstrates that an agent conversation cannot override the owner's spending rules.

## Questions to answer plainly

- **Are these real independent firms?** The local demo represents three owners in one isolated browser workspace. Production federation and independently verified identity are future work.
- **Is the negotiation an LLM?** Default role messages are deterministic for reliable demonstration. With 1Claw configured, buyer and seller also run separate Shroud advisory calls; badges distinguish them.
- **Does crypto actually move?** No. The current crypto route is simulated. The optional external route is Stripe sandbox only.
- **Where are the credentials?** Provider/Stripe credentials stay in 1Claw; only a scoped, encrypted 1Claw agent key belongs in the app environment.
- **Why a harness?** The reusable part is the structured invoice workflow, bounded agent roles, owner policy checks, adapter interface, idempotent settlement, and shared receipt/ledger linkage. It can host a Hermes adapter without tying finance correctness to one agent runtime.
