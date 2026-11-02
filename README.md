# EscrowPact — Milestone Escrow for Freelance Work on NEAR

**NEAR Hackathon "Build Beyond Boundaries" (Nov 1–14, 2026) · Track: Real-World Money (`realworld`)**

> **Independence disclosure (per HACKATHON.md Q-015):** this is an independent
> second submission by the same entrant. The entrant's other project is
> **VAULTGUARD** (a self-protecting DeFi vault guardian, `defi` track) — a
> completely separate codebase, contract, and concept. No code is shared
> between the two projects.

## The problem

Freelancers get stiffed; clients get ghosted. Today the options are: trust a
stranger, or pay a centralized platform 10–20% to hold money. EscrowPact puts
milestone payments in a **trustless on-chain escrow on NEAR**:

1. **Client** creates a job with 1–10 milestones (description + amount each).
2. **Client** funds each milestone up front — the NEAR sits in the contract.
3. **Freelancer** submits proof of work for a funded milestone.
4. **Client** approves → the contract pays the freelancer automatically.
5. **Dispute?** Either party flags it — funds lock until the client resolves
   (pay the freelancer or refund themselves).
6. **No work submitted?** The client can refund an unfunded-by-work milestone
   any time.

Every money movement is enforced by the contract. There is no admin key, no
multisig, no platform fee.

## Live on NEAR testnet

| Item | Value |
|---|---|
| Contract | `escrow.p2deployer.testnet` |
| Network | NEAR testnet |
| Deploy tx | `BUDz6cGju1m4mvhGkMuDvZqoBqSbbvubeEmFH3Gtu9H7` |
| Source | `contract/src/index.ts` (near-sdk-js 2.0.0) |
| WASM | `contract/build/contract.wasm` (549,077 bytes) |

Verify yourself:

```bash
# contract code is deployed
curl -s -X POST https://rpc.testnet.fastnear.com -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"1","method":"query","params":{"request_type":"view_account","finality":"final","account_id":"escrow.p2deployer.testnet"}}'
# list jobs (do X → see Y: returns ["job61567", ...])
```

## Try it (do X → see Y)

Prerequisite: a NEAR testnet account with a little testnet NEAR
(free from https://near-faucet.io or https://helper.testnet.near.org).

**Option A — the UI** (no build step): open `frontend/index.html` in a browser
(serve the folder or open the file directly — it loads near-api-js from CDN).
1. Paste your testnet account ID + private key → *Connect* (key stays in your
   browser; read-only browsing needs no key).
2. Create a job: fill job ID, freelancer account, title, milestones
   (`description | amount`) → *Create job*.
3. As the client, click **Fund** on a milestone → do X: funds leave your
   account; see Y: milestone pill turns green "funded".
4. As the freelancer (connect with the freelancer key), click **Submit work**,
   paste a proof URL → see Y: pill turns amber "submitted".
5. As the client, click **Approve & pay** → see Y: freelancer balance grows,
   pill turns green "approved".
6. Try **Raise dispute** on a submitted milestone → see Y: red "disputed",
   approve is blocked until resolved.

**Option B — the automated test suite** (runs the whole lifecycle on testnet):

```bash
npm run test
# exercises: create → fund → submit → approve → dispute → resolve → refund
# plus 5 negative cases (double-fund, wrong amount, wrong-role calls…)
```

## Contract API

| Method | Who | What |
|---|---|---|
| `create_job` | client | opens a job with milestones (no funds move) |
| `fund_milestone` 💰 | client | attaches **exactly** the milestone amount |
| `submit_work` | freelancer | posts proof for a funded milestone |
| `approve_milestone` 💸 | client | releases escrow → freelancer |
| `raise_dispute` | client/freelancer | locks a submitted milestone |
| `resolve_dispute` 💸 | client | pays freelancer **or** refunds client |
| `refund_milestone` 💸 | client | reclaims a milestone with no submission |
| `get_job` / `list_job_ids` | anyone | views |

Amounts are yoctoNEAR strings (bigint-safe). Every revert carries an
`EscrowPact: …` message explaining the rule that was violated.

## Build & deploy (reproducible)

```bash
npm run build    # near-sdk-js → contract/build/contract.wasm
npm run deploy   # needs .env with NEAR_DEPLOYER_ACCOUNT / NEAR_DEPLOYER_KEY (testnet)
```

The deployed WASM was built from the exact `contract/src/index.ts` in this
repo (build: 2026-11-02, near-sdk-js 2.0.0).

## What NEAR enables here

- **Trustless escrow without a custodian** — the contract (not a platform)
  holds milestone funds; releases are pure on-chain logic.
- **Named accounts as identities** — `client.<tld>` / `freelancer.<tld>`
  make jobs human-readable; subaccounts keep test actors isolated.
- **Finality in ~1s** — fund → submit → approve feels like a normal web app.

## Roadmap (post-hackathon)

- FT (USDC) escrow via `ft_transfer_call`, arbitrator role for disputes,
  deadline + auto-release timeouts, job search/filter views.

## License

MIT — see [LICENSE](LICENSE).
