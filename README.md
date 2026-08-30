# Farcaster Client Snapshot

> **This fork adds a working wallet.** The upstream snapshot below ships the bridge for an embedded
> wallet (`apps/farcaster-web`'s `EmbeddedWallet.tsx`) but no wallet to answer it. This fork adds
> one — Ethereum and Solana, real send/view/swap, real Farcaster identity signing. Start here:
> **[`apps/farcaster-wallet`](./apps/farcaster-wallet)** — technical README and full submission
> write-up (`SUBMISSION.md`) live in that folder.

A snapshot of the Farcaster client monorepo codebase without the Farcaster Wallet implementation.

This is designed to be a reference for building a social client on top of the Farcaster protocol. Both mobile and web clients run locally, pointing to the current production API by Farcaster.

## Getting Started

In the project root, install dependencies and start watching shared packages:    pnpm install && pnpm watch


Then in a new terminal, run your preferred client:

### Mobile

cd apps/farcaster-mobile
pnpm install
pnpm ios


### Web

cd apps/farcaster-web
pnpm install
pnpm start


## Contributing

This repository is a one-way, automatically generated snapshot of the Farcaster client monorepo.
Each update replaces `main` with a single fresh commit, so pull requests and issues opened *against
the upstream repo* can't be merged or tracked there, and any change pushed directly *to upstream* is
overwritten by its next snapshot.

That process applies to `farcasterxyz/client` itself — not to this fork. This fork is a normal,
independent GitHub repository; nothing re-syncs or overwrites it automatically, and the wallet added
in `apps/farcaster-wallet` is a stable, permanent addition on top of the snapshot this fork was
created from.

Fork it and build on it — that's what it's here for.

## License

See [LICENSE](./LICENSE).
