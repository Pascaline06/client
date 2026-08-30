// Confirmed against LI.FI's own OpenAPI spec (docs.li.fi/api-reference/get-a-quote-for-a-token-transfer)
// on 2026-08-28 — request params and the Step/Action/Estimate response shape
// below are copied from that spec, not reconstructed from memory. No API
// key needed for this endpoint at low volume; add one via the
// `x-lifi-api-key` header (see LIFI_API_KEY below) before any real usage,
// since the unauthenticated tier is rate-limited.

export const NATIVE_TOKEN_ADDRESS = '0x0000000000000000000000000000000000000000';

export type LifiToken = {
  address: string;
  decimals: number;
  symbol: string;
  chainId: number;
  name: string;
};

export type LifiQuote = {
  id: string;
  action: {
    fromChainId: number;
    toChainId: number;
    fromToken: LifiToken;
    toToken: LifiToken;
    fromAmount: string;
    fromAddress: string;
    toAddress?: string;
  };
  estimate: {
    fromAmount: string;
    toAmount: string;
    toAmountMin: string;
    approvalAddress: string;
    executionDuration: number;
  };
  transactionRequest: {
    from: string;
    to: string;
    chainId: number;
    data: string;
    value: string; // hex
    gasPrice?: string; // hex
    gasLimit?: string; // hex
  };
};

// Set this once you've registered at portal.li.fi — required to move off
// the shared unauthenticated rate limit, not required for this to function.
const LIFI_API_KEY: string | undefined = undefined;

export async function getEvmSwapQuote(params: {
  fromChain: number;
  toChain: number;
  fromToken: string;
  toToken: string;
  fromAmount: string; // smallest unit, e.g. wei for ETH
  fromAddress: string;
  slippage?: number;
}): Promise<LifiQuote> {
  const url = new URL('https://li.quest/v1/quote');
  url.searchParams.set('fromChain', String(params.fromChain));
  url.searchParams.set('toChain', String(params.toChain));
  url.searchParams.set('fromToken', params.fromToken);
  url.searchParams.set('toToken', params.toToken);
  url.searchParams.set('fromAmount', params.fromAmount);
  url.searchParams.set('fromAddress', params.fromAddress);
  url.searchParams.set('slippage', String(params.slippage ?? 0.005));
  url.searchParams.set('integrator', 'farcaster-wallet-fork');

  const res = await fetch(url.toString(), {
    headers: LIFI_API_KEY ? { 'x-lifi-api-key': LIFI_API_KEY } : {},
  });
  if (!res.ok) {
    // LI.FI's 404 case returns a structured "no route found" body, not just
    // an HTTP error — surface its message rather than a bare status code
    // when we can parse it.
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.message) detail = body.message;
    } catch {
      /* body wasn't JSON — stick with the status line */
    }
    throw new Error(`LI.FI quote failed: ${detail}`);
  }
  return res.json();
}

/** Formats a raw integer-string token amount (e.g. estimate.toAmount) into a
 * human-readable decimal string, given the token's decimals. */
export function formatTokenAmount(raw: string, decimals: number): string {
  const negative = raw.startsWith('-');
  const digits = (negative ? raw.slice(1) : raw).padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals) || '0';
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}
