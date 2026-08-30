# Farcaster Client Fork with a Working Wallet — Submission

**Fork:** https://github.com/Pascaline06/client
**Wallet:** [`apps/farcaster-wallet`](https://github.com/Pascaline06/client/tree/main/apps/farcaster-wallet)
**License:** MIT (unchanged from upstream)

## What this is

The [Farcaster client snapshot](https://github.com/farcasterxyz/client) ships a complete bridge for
an embedded wallet — `EmbeddedWallet.tsx` in `apps/farcaster-web` opens an iframe, hands it four
`MessagePort`s over a JSON-RPC protocol, and waits for a wallet to answer on the other side — but no
wallet exists in the snapshot to answer it. This fork adds that wallet. It's a real implementation of
every side of that bridge: Ethereum and Solana, real key management, real transaction signing, real
swaps, and real Farcaster identity signing.

Nothing in this document is a claim I'm asking you to take on faith. Every non-obvious piece of it
was independently checked — against a real published spec, against real cryptographic math, or
against a real, live network — and the parts that *couldn't* be fully verified are named explicitly
below rather than glossed over. That distinction — checked vs. claimed — is itself part of what this
submission is offering.

## How it satisfies the bounty, item by item

The bounty asks for a wallet that "supports all FC client wallet needs (buy/sell/view/send etc)."
Here's each one, mapped to what's actually in the repo:

| Requirement | Ethereum / Base / L2s | Solana |
|---|---|---|
| **View** | Address + live balance, read from a real `JsonRpcProvider` | Address + live balance, read via a self-healing multi-RPC connection |
| **Send** | `eth_sendTransaction` and `wallet_sendCalls`, broadcasting through `ethers` | `signTransaction` / `signAndSendTransaction`, broadcasting a real `VersionedTransaction` |
| **Buy/Sell** | Real LI.FI integration — live quotes, ERC-20 approval handling, broadcast | Real Jupiter integration — live quotes, broadcast |
| **Sign-in / identity** | `sign_in_with_auth_address` (SIWF) and both `silently_sign_manifest` / `silently_sign_auth_message` (JSON Farcaster Signatures) — not required by the bounty's own wording, built anyway because it's part of what a real Farcaster wallet needs | N/A — Farcaster identity is EVM-based |

Every cell above is real, working code in this repo — not a stub, not a TODO, not a declined method.

## What sets this apart from other submissions

**Solana isn't an afterthought or a declared exception.** `packages/farcaster-client-data`'s
`SolanaSchema` is unconditional in the upstream bridge — every single handshake transfers a
`solanaProvider` port and the parent wires up a real client for it (`connect`, `signMessage`,
`signAndSendTransaction`, `signTransaction`), whether or not the embedding mini app ever calls it.
A wallet that answers that channel by declining is an EVM-only wallet sitting behind a bridge that
was built for two chains — a correct answer to the protocol, but an incomplete answer to the bounty.
This fork implements all four Solana methods for real, including transaction signing and
broadcasting that's been run against a live network and independently verified.

**Buy/sell works on both chains, not one.** This is the item most likely to be missing entirely from
other submissions, because it's the hardest of the four to get right — it means integrating with a
real third-party aggregator (LI.FI for EVM, Jupiter for Solana), not just talking to your own signing
logic. Both integrations have returned real, live, correctly-priced quotes from their production
APIs during testing.

**Real Farcaster-native identity signing, not just transaction signing.** Sign-In With Farcaster and
JSON Farcaster Signatures are a different, arguably harder surface than moving tokens — they're
Farcaster's own protocol-level trust primitives, not generic wallet functionality. Both are
implemented against the actual protocol specifications and independently verified cryptographically.

**A verification methodology, documented, not just a feature list.** Most submissions will tell you
what they built. This one also tells you *how it was checked*:

- The ERC-20 `approve`/`allowance` calldata was checked against the real, well-known Ethereum
  function selectors (`0x095ea7b3` / `0xdd62ed3e`), with a full decode round trip confirming it.
- Solana transaction signing was verified by building a real `VersionedTransaction`, signing it with
  this wallet's exact shipped code, and independently checking the resulting signature
  cryptographically — not just confirming nothing threw an error.
- The SIWF sign-in message was signed and the signature independently verified to recover to the
  correct address.
- JSON Farcaster Signatures were built end to end, then decoded and verified exactly the way a real
  verifier would, per the spec's own validation steps.
- Two API assumptions that would have been wrong were caught *before* shipping: Jupiter's
  commonly-referenced `v6` quote endpoint turned out to already be deprecated, and an early Solana
  key-derivation shortcut would have silently produced an address incompatible with every other
  Solana wallet (Phantom, Backpack, etc.) using the same seed phrase.
- A public Solana RPC endpoint failed in production during testing — then a second "reliable
  alternative" also failed, a different way. Rather than a third guess, mainnet Solana access now
  runs through an ordered fallback list with a real liveness check, caching whichever endpoint
  actually responds.

**Built and tested entirely from a phone.** Every feature in this repo was developed in Termux on a
Samsung S10+ and tested by hand from a mobile browser against real testnets and real production
APIs — no laptop, no desktop IDE. The toolchain (`esbuild`, no framework) and the standalone test
harness (`demo.html`, which plays the parent's side of the bridge protocol so the wallet can be
exercised without running the full monorepo) exist specifically because of that constraint.

## Proof, not just claims

These are real, checkable facts from actual testing sessions during development — an on-chain
transaction is independently verifiable by anyone, which is a stronger form of evidence than a
screenshot or a claim:

- **EVM address used in testing:** `0x7bC1e31D445249561E02E58d5df08D1A5924aE7d`
- **Solana address used in testing:** `9Twv7xVeQomEXtueQSxqny4fu2A7kfyKWQX3tpEKxYX2`
- **A real, confirmed Base Sepolia transaction** was broadcast from this wallet during testing —
  `[INSERT VERIFIED TX HASH — check your own testing session's logs / browser history against
  sepolia.basescan.org before publishing this document, rather than trust a hash transcribed from a
  screenshot]`.
- **A real, confirmed Solana devnet transaction** was signed and broadcast from this wallet during
  testing — `[INSERT VERIFIED SIGNATURE — check against your own logs / explorer.solana.com
  (devnet) before publishing]`.
- **A real LI.FI quote** for 0.001 ETH → USDC on Base returned a correct, market-accurate price
  during testing.
- **A real Jupiter quote** for 0.001 SOL → USDC on Solana mainnet returned a correct,
  market-accurate price during testing, cross-checked against live SOL price at the time.

I'm flagging the two blanks above deliberately rather than filling them with a possibly-imperfect
transcription: pull the exact values from your own testing session before this goes out, since the
whole point of citing them is that anyone can independently check them on a block explorer.

## Honest scope — what this submission does not claim

- **No security review has happened.** Every "verified" item above means a specific technical
  detail was independently checked against a real spec or real math. It does not mean a second
  person has audited this code, and that matters more for a wallet than almost anything else.
- **Swap execution has been verified up to, not through, the final approval tap** on both chains —
  quote fetching, pricing accuracy, and the approval flow are all live-confirmed; the actual
  broadcast step for a swap specifically was deliberately not completed in testing, since doing so
  spends real money, and the underlying broadcast code is the same code already proven correct by
  the plain send-transaction tests.
- A handful of wire-format details (exact field names for a couple of parameters the parent sends)
  are educated, defensively-coded guesses rather than confirmed facts, because the exact schema
  isn't published anywhere that could be found. Each fails with a specific, readable error rather
  than silently guessing wrong if the real shape turns out to differ.
- Single account per chain family — no hardware wallet support, no smart-account/paymaster support,
  no multi-account switching yet.

Full technical detail on every point above, including exactly which files implement what, is in
[`apps/farcaster-wallet/README.md`](https://github.com/Pascaline06/client/blob/main/apps/farcaster-wallet/README.md).

## Try it yourself

```
git clone https://github.com/Pascaline06/client.git
cd client/apps/farcaster-wallet
npm install
npm run start
```

Open `http://localhost:8082/demo.html` — this test harness plays the real parent side of the bridge
protocol against the real wallet, so every method above can be exercised directly without needing
the full monorepo running.
