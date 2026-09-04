# Farcaster Wallet Bounty Submission

This fork adds `apps/farcaster-wallet` to the Farcaster client snapshot.

## Implemented

- Farcaster embedded-wallet MessagePort bridge
- EVM provider with Base, Ethereum, Optimism, Arbitrum, Polygon, Zora, Degen, Monad, Robinhood Chain, plus Base Sepolia
- Native EVM transfers and arbitrary EIP-1193 transactions
- ERC-20 transfers
- EIP-1193 signing (`personal_sign`, `eth_signTypedData_v4`)
- EIP-5792-style sequential EOA calls with status tracking
- Solana connect/sign/sign-and-send/sign-transaction
- EVM swaps through LI.FI and Solana swaps through Jupiter
- Farcaster Connect/SIWF and JSON Farcaster Signature support
- Local encrypted mnemonic storage with AES-256-GCM and PBKDF2-SHA256
- Explicit approval for connect, signatures, transfers, swaps and batches

## Verification

Run from `apps/farcaster-wallet`:

```sh
npm install
npm run smoke
npm run typecheck
npm run build
```

The smoke test is dependency-free and verifies the complete supported-chain registry. Full build/typecheck should be run in the target environment after dependency installation.

## License

MIT, inherited from the upstream Farcaster client repository.
