import fs from 'node:fs';
const source = fs.readFileSync(new URL('../src/providers/chains.ts', import.meta.url), 'utf8');
const expected = {
  8453: 'Base', 84532: 'Base Sepolia (testnet)', 1: 'Ethereum', 10: 'Optimism', 42161: 'Arbitrum One',
  137: 'Polygon', 7777777: 'Zora', 666666666: 'Degen', 143: 'Monad', 4663: 'Robinhood Chain',
};
for (const [id, name] of Object.entries(expected)) {
  if (!source.includes(`${id}:`) || !source.includes(`name: '${name}'`)) throw new Error(`Missing chain ${id} (${name})`);
}
if (!source.includes("DEFAULT_CHAIN_ID = 8453")) throw new Error('Base is no longer the default chain');
console.log(`PASS: ${Object.keys(expected).length} EVM chains are registered.`);

// Also verify every configured entry has the fields the runtime depends on.
const entries = [...source.matchAll(/\n\s*(\d+): \{ id: (\d+), name: '([^']+)', rpcUrl: '([^']+)', nativeSymbol: '([^']+)', explorerUrl: '([^']+)' \}/g)];
if (entries.length !== Object.keys(expected).length) throw new Error(`Expected ${Object.keys(expected).length} complete chain entries, found ${entries.length}`);
for (const [, idA, idB, name, rpc, symbol, explorer] of entries) {
  if (idA !== idB || !rpc.startsWith('https://') || !explorer.startsWith('https://') || !symbol) throw new Error(`Malformed chain entry ${idA} (${name})`);
}
console.log('PASS: all configured chains have HTTPS RPC/explorer endpoints and native symbols.');
