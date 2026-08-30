export type ChainConfig = {
  id: number;
  name: string;
  rpcUrl: string; // TODO: fill in real endpoints (own RPC key or a public one) before this leaves the sandbox
  nativeSymbol: string;
  explorerUrl: string;
};

export const DEFAULT_CHAIN_ID = 8453; // Base — where the Farcaster protocol itself and poidh both live

const CHAINS: Record<number, ChainConfig> = {
  8453: { id: 8453, name: 'Base', rpcUrl: 'https://mainnet.base.org', nativeSymbol: 'ETH', explorerUrl: 'https://basescan.org' },
  84532: { id: 84532, name: 'Base Sepolia (testnet)', rpcUrl: 'https://sepolia.base.org', nativeSymbol: 'ETH', explorerUrl: 'https://sepolia.basescan.org' },
  1: { id: 1, name: 'Ethereum', rpcUrl: 'https://eth.llamarpc.com', nativeSymbol: 'ETH', explorerUrl: 'https://etherscan.io' },
  10: { id: 10, name: 'Optimism', rpcUrl: 'https://mainnet.optimism.io', nativeSymbol: 'ETH', explorerUrl: 'https://optimistic.etherscan.io' },
  42161: { id: 42161, name: 'Arbitrum One', rpcUrl: 'https://arb1.arbitrum.io/rpc', nativeSymbol: 'ETH', explorerUrl: 'https://arbiscan.io' },
  // These are free public endpoints — fine for development, but they're
  // rate-limited and not something to depend on once this handles real
  // funds. Swap in your own Alchemy/Infura/QuickNode URL per chain before
  // this goes anywhere past testing.
};

export function getChainConfig(id: number): ChainConfig | undefined {
  return CHAINS[id];
}

export function listChains(): ChainConfig[] {
  return Object.values(CHAINS);
}
