// Confirmed against dev.jup.ag's OpenAPI spec (developers.jup.ag/docs/api-reference/swap/v1/quote
// and .../swap) on 2026-08-28 — this is Jupiter's current "Swap V2" API.
// The older quote-api.jup.ag/v6 endpoint many tutorials still reference is
// superseded; using it risks hitting a deprecated/unmaintained path.
//
// Free tier: lite-api.jup.ag/swap/v1, no API key. Production: api.jup.ag/swap/v1
// with an x-api-key header (portal at developers.jup.ag) — same pattern as
// LI.FI's key requirement in lifi.ts.

export const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';

const BASE_URL = 'https://lite-api.jup.ag/swap/v1';

export type JupiterQuote = {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: 'ExactIn' | 'ExactOut';
  slippageBps: number;
  priceImpactPct: string;
  routePlan: Array<{ swapInfo: { label: string; ammKey: string } }>;
};

export async function getSolanaSwapQuote(params: {
  inputMint: string;
  outputMint: string;
  amount: string; // raw units, before decimals
  slippageBps?: number;
}): Promise<JupiterQuote> {
  const url = new URL(`${BASE_URL}/quote`);
  url.searchParams.set('inputMint', params.inputMint);
  url.searchParams.set('outputMint', params.outputMint);
  url.searchParams.set('amount', params.amount);
  url.searchParams.set('slippageBps', String(params.slippageBps ?? 50));

  const res = await fetch(url.toString());
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) detail = body.error;
    } catch {
      /* not JSON, stick with the status line */
    }
    throw new Error(`Jupiter quote failed: ${detail}`);
  }
  return res.json();
}

/** Returns a base64-encoded serialized VersionedTransaction, ready to hand
 * straight to signAndBroadcastSerializedTransaction in solanaProvider.ts —
 * same wire format that module already signs for signTransaction. */
export async function getSolanaSwapTransaction(params: {
  quote: JupiterQuote;
  userPublicKey: string;
}): Promise<string> {
  const res = await fetch(`${BASE_URL}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userPublicKey: params.userPublicKey,
      quoteResponse: params.quote,
      dynamicComputeUnitLimit: true,
    }),
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) detail = body.error;
    } catch {
      /* not JSON */
    }
    throw new Error(`Jupiter swap-transaction build failed: ${detail}`);
  }
  const body = await res.json();
  if (!body.swapTransaction) throw new Error('Jupiter /swap response had no swapTransaction field.');
  return body.swapTransaction;
}

/** Same helper as lifi.ts's formatTokenAmount — kept separate rather than
 * shared, since the two swap modules are otherwise fully independent and a
 * shared util would be the only coupling between them. */
export function formatSplAmount(raw: string, decimals: number): string {
  const negative = raw.startsWith('-');
  const digits = (negative ? raw.slice(1) : raw).padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals) || '0';
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

/** Jupiter's quote response gives mint addresses and raw amounts but no
 * symbol or decimals (unlike LI.FI's response) — reads decimals directly
 * off the mint account via Solana's standard jsonParsed RPC decoding
 * (data.parsed.info.decimals for an SPL Token/Token-2022 mint), rather than
 * a token-list API lookup that would be one more unverified schema. This
 * specific RPC shape rests on long-established, stable Solana RPC behavior
 * — not the kind of recently-changed REST API version this whole swap
 * effort has had to keep double-checking — but it still hasn't been
 * exercised against a live node from this environment, for the same
 * network-egress reason as everything else Solana-related here.
 * WRAPPED_SOL_MINT is special-cased to 9, its known fixed value, since it's
 * often not treated as a normal mint account by RPC parsers. */
export async function getMintDecimals(connection: import('@solana/web3.js').Connection, mint: string): Promise<number> {
  if (mint === WRAPPED_SOL_MINT) return 9;
  const { PublicKey } = await import('@solana/web3.js');
  const info = await connection.getParsedAccountInfo(new PublicKey(mint));
  if (info.value === null) {
    // The single most likely real-world cause: querying a mainnet mint
    // address against a devnet (or vice versa) RPC endpoint. That mismatch
    // produced exactly this error the first time this ran for real — worth
    // naming directly rather than making the next person re-diagnose it.
    throw new Error(
      `No account found for mint ${mint} — this usually means the mint exists on a different cluster than the one being queried (e.g. a mainnet token address checked against a devnet RPC).`,
    );
  }
  const parsed = info.value.data;
  if (!parsed || typeof parsed !== 'object' || !('parsed' in parsed)) {
    throw new Error(`Could not read decimals for mint ${mint} — account exists but data wasn't in the expected parsed SPL mint shape.`);
  }
  const decimals = (parsed as { parsed: { info: { decimals: number } } }).parsed.info.decimals;
  if (typeof decimals !== 'number') {
    throw new Error(`Could not read decimals for mint ${mint} — parsed account had no numeric decimals field.`);
  }
  return decimals;
}
