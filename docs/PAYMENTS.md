# Optional Solana Devnet payments

> **DEVNET TEST: no real value.** This feature uses the Solana **Devnet** test network only. Devnet SOL is free and
> worthless. Nothing here touches mainnet or real money, and the server refuses to run against any other cluster.

Pixels stays **fully playable without a wallet or any payment**. Solana is used for exactly two things:

1. **Sign in / link a wallet**: a player proves they control a wallet by signing a free text message.
2. **Pay for goods with Devnet SOL**: a player buys an item by sending a small Devnet transaction from their own wallet.

Everything is behind a feature flag (`PAYMENTS_ENABLED`, default `false`). When it is off the wallet and payment
endpoints answer `404`, the web app shows nothing wallet-related, and **no wallet code is downloaded**.

## Product rules (and where they are enforced)

| Rule | How |
| --- | --- |
| Playable without a wallet | Wallet/pay code is isolated behind `GET /api/config` + lazy chunks; coins shop untouched |
| Devnet only | `SOLANA_CLUSTER` must be `devnet`; RPC URL guard (https, no mainnet/testnet); **genesis-hash check** against the node; client RPC must contain `devnet` |
| No private keys or seed phrases anywhere | Server holds only the treasury **public** key; config refuses a secret key / `*PRIVATE_KEY*` / seed env vars; players sign in their own wallet |
| Labelled "DEVNET TEST: no real value" | Wallet modal, shop footer, pay buttons, toasts, and every wallet/pay API `error`/`message` (plus a `notice` field) |
| Never claim a purchase unless verified on-chain | Item is granted only after the server fetched the transaction from the Devnet node and every check passed |
| The AI never pays | The Town Guide has no payment tool. The only path is the player's own click plus the wallet's own approval popup |

## Architecture

```
 Browser (apps/web)                         Server (apps/server)                         Solana Devnet
 ───────────────────────────────────────    ─────────────────────────────────────────    ───────────────
 main bundle: GET /api/config  ───────────▶ solana/routes.ts  (feature flag, rate limits)
   enabled? ──▶ lazy "ui" chunk (buttons)   solana/wallet.ts  (challenge / verify / link)
                 └▶ lazy "WalletModal"      solana/payments.ts (intents, confirm, ledger)
                     └▶ lazy "controller"   solana/verify.ts   (pure on-chain checks)
                        @solana/web3.js     solana/rpc.ts      (JSON-RPC over fetch) ─────▶ getGenesisHash
                        wallet-standard                                                      getTransaction
 wallet extension signs + sends ──────────────────────────────────────────────────────────▶ (confirmed)
```

Server files (`apps/server/src/solana/`):

| File | Role |
| --- | --- |
| `config.ts` | `parsePaymentsConfig(env)`: flag, cluster guard, RPC URL guard, secret-key refusal |
| `types.ts` | `SolanaRpc` interface (injectable), parsed-transaction types, `RpcError` |
| `rpc.ts` | `HttpSolanaRpc`: `getGenesisHash`, `getTransaction` (`confirmed`, `jsonParsed`, `maxSupportedTransactionVersion: 0`) with timeout and size cap; the URL is never logged (only the host) |
| `wallet.ts` | `WalletAuth`: single-use, key-bound, 5-minute challenges; ed25519 verification with `tweetnacl`; link / unlink / sign-in rules |
| `payments.ts` | `SolanaPayments`: cluster guard, pay intents, `confirm` (idempotent, replay-proof), grants through `Shop.grantItem` |
| `verify.ts` | `verifyPaymentTransaction`: pure, fail-closed checks on a parsed transaction |
| `routes.ts`, `schemas.ts` | HTTP surface, rate limits, request validation, `DEVNET` labelling |

Persistence: payment **intents** and the **used-signature ledger** live in the same `db.json` as accounts (one atomic
write), so a crash cannot grant an item without recording the signature. Both survive restarts.

The shop's `PaymentProvider` seam (`shop.ts`) is **not** used for SOL: that seam is a synchronous "take coins from the
balance" call inside the WebSocket `shop_buy` flow, whereas a SOL payment is a two-step, wallet-signed, asynchronous
flow. The two paths share the same inventory code instead: `Shop.grantItem` (ownership and stack rules, then add and
save), which coin purchases now also use.

Web files (`apps/web/src/wallet/`): `config.ts` + `slots.tsx` (the only wallet code in the main bundle),
`ui.ts` (lazy chunk with the toolbar button, wallet chip, shop pay button, sign-in button), `WalletModal.tsx`,
`controller.ts` (all Solana libraries), `tx.ts` (transaction builder), `api.ts`, `store.ts`, `pending.ts`,
`format.ts` / `walletErrors.ts` / `cluster.ts` (pure helpers).

## Flows

### Link a wallet (signed in) and sign in with a wallet

```
POST /api/wallet/challenge {publicKey}          → {nonce, message, expiresAt}        (5 min, single use, bound to the key)
  wallet.signMessage(message)                       (free; no transaction; shown to the player first)
POST /api/wallet/verify {publicKey, signature(base58), nonce?}
   with  Authorization: Bearer <token>  → LINK the wallet to that account           → {mode:'link', account}
   without a bearer, wallet already linked → SIGN IN                                → {mode:'signin', token, account}
   without a bearer, unknown wallet        → 404 "create an account first, then link"
DELETE /api/wallet   (bearer)                  → unlink (idempotent)
```

Rules: one wallet per account (unlink first to change); a wallet already linked to another account is refused (`409`);
an invalid bearer is `401` (never a silent fall-through to sign-in); a challenge is consumed only by a *valid*
signature, so a stranger cannot burn someone else's pending challenge; up to 5 pending challenges per key.

### Pay with Devnet SOL

```
POST /api/pay/intent {itemId}   (bearer, wallet linked, item has priceLamports, not already owned)
   → {intentId, itemId, lamports, treasury, reference, memo:"pixels:<intentId>", expiresAt (10 min), cluster:'devnet'}
 browser: SystemProgram.transfer(payer → treasury, lamports) + reference as READ-ONLY NON-SIGNER key + Memo instruction
          wallet.signAndSendTransaction(chain 'solana:devnet')       ← the player's normal wallet approval popup
POST /api/pay/confirm {intentId, signature}   (bearer)
   → 200 {ok, item, signature, message}   | 202 pending (not visible yet: the client polls) | 4xx/5xx with `code`
   server pushes an `account` WebSocket message (inventory) + a toast; the web client also refreshes /api/me
```

Prices come **only** from the server catalogue (`priceLamports` in `packages/shared/src/catalog.ts`: Explorer Cap
0.002 SOL, Sunset Hoodie 0.005 SOL, Genesis Pixel 0.01 SOL; coin prices are unchanged, items are payable both ways).
The client also cross-checks the intent against the shared catalogue and `/api/config` and refuses on any mismatch.
SOL purchases do not require standing at the shop counter (that is a coin-shop game rule).

`confirm` checks, in order: valid base58 signature; intent exists and belongs to the caller (`404` otherwise);
already settled (same signature = same answer again, different signature = `409`); not past deadline + 5 min grace
(`410`); signature not in the ledger (`409 signature_reused`); linked wallet is still the intent's payer; cluster guard;
fetch the transaction (retried for up to `SOLANA_CONFIRMATION_TIMEOUT_MS`, default 20 s, then `202 pending`); then
`verifyPaymentTransaction`:

- the returned transaction's first signature equals the requested one;
- `meta.err === null` (it succeeded);
- slot is a positive integer; `blockTime` exists, is not before the intent was created (2 min skew allowed), not after
  the deadline (+ skew), not in the future;
- the **linked wallet** is a signer of the transaction (payer ≠ treasury);
- the intent's one-time **reference** key is in the account keys, and is not a signer;
- a top-level `system` `transfer` from the linked wallet to the treasury of **at least** `intent.lamports`;
- a Pixels memo, if present, names this intent;
- the treasury's balance rose by at least the price (`postBalances − preBalances`).

Only then: re-check state synchronously (no `await` between check, grant and ledger write), grant via `Shop.grantItem`,
mark the intent fulfilled, record the signature, push the `account` message. Concurrent confirms for one intent are
serialised; confirming twice returns the identical result and never double-grants. If the player obtained a
non-consumable meanwhile, the payment is recorded as `paid_not_granted` (signature burned, `warn` log, `409`): there is
no automatic refund in this test build.

Error codes: `bad_signature` 400, `unknown_intent` 404, `intent_expired` 410, `signature_reused` / `already_fulfilled` /
`wallet_changed` / `paid_not_granted` / `already_owned` / `wallet_required` 409, `tx_mismatch` / `tx_failed` /
`bad_time` / `wrong_sender` / `missing_reference` / `wrong_recipient` / `amount_too_low` / `memo_mismatch` /
`balance_mismatch` 422, `rate_limited` 429, `cluster_guard` / `rpc_unavailable` 503, `pending` 202.

### Resilience

If the tab closes (or the network drops) after the wallet sent the transaction but before the server confirmed it, the
signature is kept in `localStorage` (public data only) and re-checked the next time the shop opens.

## Security model

| Threat | Mitigation |
| --- | --- |
| Client lies about the price | Amount is taken from the server catalogue; the client never sends one |
| Pay a cheap item, claim an expensive one | The intent fixes item and amount; the transfer must be ≥ that amount |
| Someone else claims my payment | Needs the intent's random reference (only the intent's owner is told it) **and** the transfer's sender must be the intent owner's linked wallet |
| Replay one transaction for many intents (even one that names several references) | Used-signature ledger, persisted, checked before and after the RPC call |
| Replay a signed wallet challenge | Single use, key-bound, 5-minute TTL; consumed on the first valid signature |
| Fake / failed / unconfirmed transaction | Fetched from the node at `confirmed`; `meta.err` must be null; treasury balance delta checked |
| Wrong cluster (mainnet/testnet) | Config guard + URL guard + **genesis hash** check (sticky `blocked` state disables all wallet/pay endpoints; `index.ts` exits at startup) |
| Private key leakage | The server never has one; config refuses a 64-byte key / JSON keypair in `SOLANA_TREASURY_PUBKEY` and any `*PRIVATE*KEY*`, seed or mnemonic env var; no key material in the web app |
| Race: double grant | Synchronous check→grant→ledger section + per-intent serialisation + idempotent settled-intent answers |
| Abuse / DoS | Per-IP limits on challenge/verify (10 burst, 10/min), per-account limits on intent (10 burst, 10/min) and confirm (30/min); bounded challenge store; 10 KB body cap; RPC timeout and 1 MB response cap |
| Log leaks | Logs carry ids, public keys and signatures only; the RPC URL (may hold an API key) is never logged, only its host |

Known limitations (preview-grade, be aware):

- **The account system is preview-grade**: login is username + email with no verification. Linking a wallet adds a
  second way in, but anyone who can log in as an account can also link/unlink a wallet on it. Treat a wallet-linked
  account as no more secure than the email login until real authentication exists.
- The challenge message is **not domain-bound** (a phishing site could relay a Pixels challenge). Adopting the Wallet
  Standard "Sign In With Solana" feature (`solana:signIn`), where the wallet enforces the domain, is the hardening step.
- Ledger-style hardware wallets often cannot `signMessage`; use a software wallet for sign-in/linking in this build.
- A payment made after the intent was fulfilled with another transaction, or for an item that became owned meanwhile, is
  not refunded automatically (Devnet only; see `paid_not_granted`).
- Dependencies: `@solana/web3.js` is pinned to the 1.99 line because the wallet-adapter packages peer-depend on
  `^1.99.0` (the 3.x line is not compatible with them). `npm audit` flags `web3.js`' transitive `jayson`
  (`stream-json`, `uuid`) with no fix available: `stream-json` is Node-only and is not in the browser bundle, and the
  `uuid` advisory concerns v3/v5/v6 with a caller-supplied buffer, which the browser client does not use. Nothing from
  the Solana packages is installed on the server side (the server uses only `tweetnacl` and `bs58`).

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PAYMENTS_ENABLED` | `false` | Feature flag. Off: endpoints `404`, no wallet UI, no wallet chunk |
| `SOLANA_CLUSTER` | `devnet` | Must be `devnet` (anything else makes the server refuse to start) |
| `SOLANA_RPC_URL` | `https://api.devnet.solana.com` | https (http only for localhost mocks); must not look like mainnet/testnet; genesis hash is checked at runtime |
| `SOLANA_TREASURY_PUBKEY` | none | **Public** key that receives payments. Required when enabled |
| `SOLANA_CONFIRMATION_TIMEOUT_MS` | `20000` | How long one `confirm` request waits for the transaction to appear (1000-120000) |
| `SOLANA_TOKEN_MINT` | none | Reserved: SPL-token pricing is **not implemented**; setting it only logs a warning |
| `VITE_SOLANA_RPC_URL` | public Devnet node | Build-time, browser side; must contain `devnet`, otherwise ignored |

Startup behaviour: an enabled-but-unsafe config exits with a clear message. If the RPC node answers with a non-Devnet
genesis hash, the server logs an error and shuts down. If the node is merely unreachable the game keeps running and
payments answer `503` until it is (re-checked on each confirm).

## Getting Devnet SOL

Use the official faucet: <https://faucet.solana.com> (choose **Devnet**, paste your wallet's address). It is
rate-limited; the shop prices are tiny (0.002 to 0.01 SOL) so one airdrop covers many purchases. Set your wallet to
Devnet first (Phantom: *Settings → Developer Settings → Testnet Mode → Solana Devnet*; Solflare/Backpack have a network
or "Developer" setting too). The UI links to the faucet from the wallet dialog and the shop footer.

## Run it with payments enabled

On **your own machine only** (never on the server, never in the repo), create a treasury wallet and copy just the
public key. The secret key is not needed by Pixels at all; keep it somewhere safe if you want to move the (worthless)
Devnet SOL later:

```bash
solana-keygen new --outfile ~/pixels-devnet-treasury.json    # keep this file OFF the server and OUT of git
solana-keygen pubkey ~/pixels-devnet-treasury.json           # prints the PUBLIC key
```

(Alternatively paste the public address of any Devnet wallet account you own.) Then in `.env`:

```bash
PAYMENTS_ENABLED=true
SOLANA_CLUSTER=devnet
SOLANA_TREASURY_PUBKEY=<the public key printed above>
# SOLANA_RPC_URL=https://api.devnet.solana.com   (default)
```

```bash
npm run build && npm start        # or: npm run dev
curl localhost:8787/api/config    # {"enabled":true,"cluster":"devnet","treasury":"…","tokenMint":null}
```

## Manual test checklist

1. **Off by default**: with `PAYMENTS_ENABLED=false` no Wallet button, no "Sign in with wallet", no "Pay … SOL" buttons;
   `curl -i -X POST localhost:8787/api/pay/intent` is `404`; browser network tab shows no `ui-*`, `WalletModal-*`,
   `controller-*` chunk requests.
2. **Guards**: `SOLANA_CLUSTER=mainnet-beta` → server refuses to start; `SOLANA_RPC_URL=https://api.mainnet-beta.solana.com`
   → refuses; a 64-byte key in `SOLANA_TREASURY_PUBKEY` → refuses; missing treasury → refuses.
3. **Enabled**: Wallet button appears in the toolbar; login screen shows "Sign in with wallet" (labelled DEVNET).
4. **No wallet installed**: open the wallet dialog → "No Solana wallet found" with Phantom/Solflare/Backpack links.
5. **Connect + link**: wallet on Devnet, Faucet SOL; Wallet → pick wallet → shortened key + DEVNET badge + Disconnect →
   *Link wallet* shows the exact message → approve in the wallet → "Linked", wallet chip under your name. Reject in the
   wallet → friendly "declined" message and nothing linked.
6. **Pay**: ask the Town Guide "show me what I can buy" → on Explorer Cap press *Pay 0.002 SOL (Devnet test)* → wallet
   popup (check recipient = treasury, amount) → approve → "Confirming…" → "Verified on Solana Devnet" → item Owned; look the
   signature up at `https://explorer.solana.com/tx/<signature>?cluster=devnet`. Coins unchanged.
7. **Persistence / replay**: reload and restart the server: item still owned; the Pay button is disabled; replaying the
   same `POST /api/pay/confirm` returns the same success without a second grant.
8. **Failure modes**: reject the wallet popup (nothing granted); disconnect the wallet and press Pay (dialog opens with a
   hint); point `SOLANA_RPC_URL` at an unreachable host → "could not reach Solana Devnet", nothing granted; close the tab
   right after approving, reopen the shop → the payment is re-checked and granted.
9. **Sign in with wallet**: log out, *Sign in with wallet* → same account, same inventory. An unknown wallet gets the
   "create an account first" message. Link the same wallet from a second account → refused.
10. **Unlink**: Wallet → *Unlink wallet*; pay buttons then ask you to link again.

## Tests

```bash
npm test -w @pixels/shared      # lamport prices, catalogue, constants
npm test -w @pixels/server      # solana.wallet / solana.pay / solana.units tests (mock RPC, real ed25519 keypairs)
npm test -w @pixels/web         # pure helpers, tx builder (stub + real web3.js), client↔server verification contract
npm run build && node e2e/payments.mjs   # real server + real bundle + headless browser + fake wallet + mock Devnet node
```

The server tests inject a mock `SolanaRpc` and generate real `tweetnacl` keypairs; they cover challenge/verify
(success, wrong key, replayed nonce, expired nonce, tampered message), link/unlink/sign-in, wallet-linked-elsewhere,
intent rules, confirm success, wrong recipient / low amount / wrong sender / missing reference / failed tx / expired
intent / another account's intent / replayed signature (including one transaction naming two references) / double and
concurrent confirm / pending / RPC failure / non-devnet guard / restart persistence / disabled flag. A real local
JSON-RPC server exercises the production `HttpSolanaRpc`. `e2e/payments.mjs` drives the whole UI flow (see its header).

## What was NOT verified against real Devnet

The development sandbox has no route to Solana (only the npm registry is reachable), so **nothing here has touched the
real Devnet or a real wallet**. Verified instead: unit/integration tests with a mock node, a headless-browser run with a
fake Wallet-Standard wallet that signs with a real ed25519 key and a local mock node, and a contract test that compiles
the browser's transaction with the real `@solana/web3.js` and feeds it to the server's verifier. Please confirm on real
Devnet:

- the shape of a real `getTransaction` (`jsonParsed`) answer matches the mock (checked against the `@solana/rpc-types`
  type definitions, not against a live node): `accountKeys[].{pubkey,signer,writable}`, a parsed `system` `transfer`
  with `info.{source,destination,lamports}`, `meta.{err,preBalances,postBalances}`, and the memo's `parsed` string;
  that `blockTime` is populated at `confirmed`; and that the reference account key appears in `accountKeys`;
- the Devnet genesis hash constant (`EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`; it matches the constant in the
  independent `gill` package, but run `solana genesis-hash -u devnet` once). If it were wrong the server fails closed
  (payments blocked, logged), never open;
- real wallets: Phantom / Solflare / Backpack Wallet-Standard behaviour for `signMessage`, `signAndSendTransaction` on
  `solana:devnet`, their Devnet toggles and popups, and the exact error text they throw on rejection or a wrong network;
- latency: how long a just-sent transaction takes to be visible (retry budget `SOLANA_CONFIRMATION_TIMEOUT_MS`).

## Decision: SOL only (SPL token is the next step)

Payments are **SOL only**. SPL-token pricing was not implemented to keep the verification surface small and fully
tested; `SOLANA_TOKEN_MINT` and `PaymentConfigView.tokenMint` are reserved (the server reports `null` and warns).

### Next step: SPL token price

1. Catalogue: `priceToken?: { amount: string; decimals: number }` (base units) next to `priceLamports`.
2. Config: `SOLANA_TOKEN_MINT` (a Devnet mint you create on your machine with `spl-token create-token --url devnet`);
   derive the treasury's associated token account (ATA); have the server (or the owner) create it once so players never pay rent for it.
3. Intent: add `mint`, `treasuryTokenAccount` and the base-unit `amount`; keep the random `reference`.
4. Client (`tx.ts`, `@solana/spl-token`): `createTransferCheckedInstruction(payerATA, mint, treasuryATA, payer, amount, decimals)`
   with the reference appended as a read-only non-signer key; payer needs a token account with a balance.
5. Verify (`verify.ts`): find the top-level `spl-token` `transferChecked` (`info.{source,destination,mint,authority,tokenAmount}`);
   require `mint` = configured mint, `authority` = the linked wallet, destination = the treasury ATA, `amount` ≥ price;
   cross-check `meta.preTokenBalances/postTokenBalances` (treasury owner + mint) delta ≥ price. Handle Token-2022 transfer fees.
6. Tests: extend `mockPaymentTx` with token balances; mirror the SOL cases (wrong mint, wrong destination, low amount, wrong owner).

### Next step: on-chain collectible minting

Today collectibles are mock in-game items (`onChain: false`). To mint a real Devnet asset after a verified payment:

- **Keep the "no server key" rule where possible**: let the *player* sign the mint. A Metaplex Candy Machine v3 / Candy
  Guard with a `solPayment` guard pays the treasury and mints the asset to the player in one wallet-approved
  transaction; the server then verifies by reading the on-chain asset (owner = linked wallet, collection = ours) instead of
  a transfer instruction, and still uses the intent `reference` and the signature ledger for idempotency.
- If the server must mint (airdrop-style), that needs a **mint-authority private key on the server**, which breaks the
  current rule. Do that only as a conscious product decision: a dedicated Devnet-only low-value key kept in a secrets
  manager (never the treasury), minimal permissions, and a mint queue that records the mint address in the ledger so a retry
  can never mint twice.
- Asset type: Metaplex Core (`@metaplex-foundation/mpl-core`, one cheap account per asset) or compressed NFTs
  (Bubblegum) for volume; metadata JSON hosted on Arweave/IPFS or served by Pixels.
- Catalogue/UI: change `ShopItem.onChain` from the literal `false`, show the asset address with an explorer link
  (`?cluster=devnet`), and drop the "MOCK / TEST ITEM" tag only for assets that really are minted.
- Adopt `solana:signIn` (SIWS) for sign-in at the same time (domain-bound message).
