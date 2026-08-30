// Confirmed, not guessed: farcasterxyz/protocol discussion #225 states
// directly — "SIWF is just a wrapper around SIWE to make requesting
// signatures and delivering them to apps easy. The core auth always came
// from a SIWE signature." And the miniapps SDK reference for
// `sdk.actions.signIn` shows the exact returned shape:
// `{ message: string; signature: string }`, with `message` being a plain
// SIWE-formatted string ("yoink.party wants you to sign in..."). This
// builds that plaintext message per EIP-4361's standard field order.
//
// One thing this file does NOT and cannot do: actually register this
// wallet's address as a Farcaster "auth address." That's a separate,
// on-chain step (adding a key to the Key Registry contract) that only a
// user's custody address can perform, normally through a Farcaster client's
// own UI — confirmed from farcasterxyz/protocol's SPECIFICATION.md: "Only
// the custody address of the fid may add or remove signers for that fid."
// This wallet can produce a syntactically correct, correctly-signed SIWE
// message from its own address, but that signature only means anything to
// a verifier if this exact address was already registered that way. There
// is no way to check that from inside the wallet.

export type SiwfSignInParams = {
  nonce: string;
  notBefore?: string; // ISO 8601
  expirationTime?: string; // ISO 8601
};

// Farcaster's Id/Key Registry contracts are deployed on Optimism (chain id
// 10) — confirmed directly from farcasterxyz/protocol's own
// SPECIFICATION.md, not assumed. auth-kit's SIWF implementation fixes the
// SIWE message's Chain ID to this value regardless of which chain a given
// mini app otherwise operates on, since that's the chain a verifier
// actually checks the registry against.
const FARCASTER_IDENTITY_CHAIN_ID = 10;

export function buildSiwfMessage(params: {
  domain: string;
  address: string;
  uri: string;
  signIn: SiwfSignInParams;
}): string {
  const issuedAt = new Date().toISOString();
  const lines = [
    `${params.domain} wants you to sign in with your Ethereum account:`,
    params.address,
    '',
    'Farcaster Connect', // the SIWE "statement" line — FIP-11 discussion shows this exact wording used in practice, though it's flagged there as having varied between "Farcaster Auth" and "Farcaster Connect" across the protocol's own history, so treat the precise wording as best-effort rather than exactly pinned down
    '',
    `URI: ${params.uri}`,
    'Version: 1',
    `Chain ID: ${FARCASTER_IDENTITY_CHAIN_ID}`,
    `Nonce: ${params.signIn.nonce}`,
    `Issued At: ${issuedAt}`,
  ];
  if (params.signIn.expirationTime) lines.push(`Expiration Time: ${params.signIn.expirationTime}`);
  if (params.signIn.notBefore) lines.push(`Not Before: ${params.signIn.notBefore}`);
  return lines.join('\n');
}
