// Confirmed directly from the complete text of farcasterxyz/protocol
// discussion #208 ("FIP: JSON Farcaster Signatures"), fetched and read in
// full — not inferred from a truncated snippet. Quoting the spec's own
// steps:
//
//   1. Header = { fid, type, key }, JSON.stringify'd, base64url-encoded.
//   2. Payload = arbitrary JSON, JSON.stringify'd, base64url-encoded.
//   3. Signing input = ASCII(`${encodedHeader}.${encodedPayload}`), signed
//      with a plain personal-sign (ERC-191) — the same primitive
//      personal_sign and SIWF both already use in this wallet.
//   4. The signature's RAW BYTES (not its hex string) are base64url-encoded.
//      The spec calls this out explicitly as a real, documented bug in
//      earlier tooling: base64-encoding the UTF-8 TEXT of the hex string
//      instead of decoding the hex to bytes first produces a
//      longer (176-char) "legacy" signature that some verifiers still
//      accept for backwards compatibility, but new tooling should produce
//      the correct 88-char form. This implementation does the correct one.
//
// One real inconsistency worth naming rather than silently resolving: a
// live example in Farcaster's own mini-app manifest spec (the "account
// association" example) has a signature field that decodes as STANDARD
// base64 (it contains '/' and '=' padding) — not base64url, despite
// FIP-208 explicitly saying base64url. That's a discrepancy in Farcaster's
// own published material, confirmed by decoding their own example, not a
// guess made here. This implementation follows the current canonical
// FIP-208 text throughout (base64url for header, payload, AND signature),
// since that's the documented current standard a mini app SDK built today
// would most likely target.

export type JfsHeader = { fid: number; type: 'custody' | 'auth' | 'app_key'; key: string };

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function utf8ToBase64Url(str: string): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(str));
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  return bytes;
}

/** `sign` should return a 0x-prefixed hex ERC-191 signature — e.g.
 * `(message) => requireUnlockedEvm().signMessage(message)`. Returns the
 * JSON-serialized form (header/payload/signature as separate base64url
 * fields), matching the shape shown in Farcaster's own manifest example. */
export async function buildJfs(params: {
  header: JfsHeader;
  payload: Record<string, unknown>;
  sign: (message: string) => Promise<string>;
}): Promise<{ header: string; payload: string; signature: string }> {
  const encodedHeader = utf8ToBase64Url(JSON.stringify(params.header));
  const encodedPayload = utf8ToBase64Url(JSON.stringify(params.payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const hexSignature = await params.sign(signingInput);
  const encodedSignature = base64UrlEncodeBytes(hexToBytes(hexSignature));
  return { header: encodedHeader, payload: encodedPayload, signature: encodedSignature };
}
