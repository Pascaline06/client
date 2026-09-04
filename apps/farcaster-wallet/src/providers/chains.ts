/** EVM networks the embedded wallet can actually route through its EOA.
 *
 * Keep this table as the single source of truth for chain switching, RPC
 * reads, native sends, and LI.FI swaps. Adding a network here must not require
 * a second wallet implementation.
 */
export type ChainConfig = {
  id: number;
  name: string;
  rpcUrl: string;
  nativeSymbol: string;
  explorerUrl: string;
};

export const DEFAULT_CHAIN_ID = 8453; // Base

const CHAINS: Record<number, ChainConfig> = {
  8453: { id: 8453, name: 'Base', rpcUrl: 'https://mainnet.base.org', nativeSymbol: 'ETH', explorerUrl: 'https://basescan.org' },
  84532: { id: 84532, name: 'Base Sepolia (testnet)', rpcUrl: 'https://sepolia.base.org', nativeSymbol: 'ETH', explorerUrl: 'https://sepolia.basescan.org' },
  1: { id: 1, name: 'Ethereum', rpcUrl: 'https://eth.llamarpc.com', nativeSymbol: 'ETH', explorerUrl: 'https://etherscan.io' },
  10: { id: 10, name: 'Optimism', rpcUrl: 'https://mainnet.optimism.io', nativeSymbol: 'ETH', explorerUrl: 'https://optimistic.etherscan.io' },
  42161: { id: 42161, name: 'Arbitrum One', rpcUrl: 'https://arb1.arbitrum.io/rpc', nativeSymbol: 'ETH', explorerUrl: 'https://arbiscan.io' },
  137: { id: 137, name: 'Polygon', rpcUrl: 'https://polygon-rpc.com', nativeSymbol: 'POL', explorerUrl: 'https://polygonscan.com' },
  7777777: { id: 7777777, name: 'Zora', rpcUrl: 'https://rpc.zora.energy', nativeSymbol: 'ETH', explorerUrl: 'https://explorer.zora.energy' },
  666666666: { id: 666666666, name: 'Degen', rpcUrl: 'https://rpc.degen.tips', nativeSymbol: 'DEGEN', explorerUrl: 'https://explorer.degen.tips' },
  143: { id: 143, name: 'Monad', rpcUrl: 'https://rpc.monad.xyz', nativeSymbol: 'MON', explorerUrl: 'https://monadvision.com' },
  4663: { id: 4663, name: 'Robinhood Chain', rpcUrl: 'https://rpc.mainnet.chain.robinhood.com', nativeSymbol: 'ETH', explorerUrl: 'https://robinhoodchain.blockscout.com' },
};

export function getChainConfig(id: number): ChainConfig | undefined {
  return CHAINS[id];
}

export function listChains(): ChainConfig[] {
  return Object.values(CHAINS);
}
