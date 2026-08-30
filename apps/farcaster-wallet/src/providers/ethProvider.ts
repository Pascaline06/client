import { ERR_USER_REJECTED, ERR_INTERNAL, ERR_INVALID_PARAMS, RpcError } from '../bridge/rpc';
import { requireUnlockedEvm, isUnlocked } from '../keys/keyManager';
import { requestApproval } from '../ui/approval';
import { getChainConfig, DEFAULT_CHAIN_ID } from './chains';
import { JsonRpcProvider } from 'ethers';

// Methods verified straight from EmbeddedWallet.tsx's `shouldOpenWallet` /
// `isUtilityMethod` lists — this is the exact method surface the parent
// actually drives, not a guess at "the EIP-1193 spec":
//   eth_requestAccounts, eth_sendTransaction, eth_signTypedData_v4,
//   personal_sign, wallet_sendCalls   (these open the wallet UI)
//   eth_chainId, eth_accounts, wallet_switchEthereumChain (utility, silent)
// wallet_getCallsStatus and wallet_getCapabilities are named in the upstream
// miniapp docs (EIP-5792 batching) so they're included too.

let currentChainId = DEFAULT_CHAIN_ID;
let originGetter: () => string = () => '(unknown origin)';
let eventEmitter: (event: string, data: unknown) => void = () => {};

/** Called once from index.ts after the bridge is up, so this module can
 * push events (chainChanged, etc.) back to the parent without needing
 * direct access to the warpcast client itself. */
export function setEventEmitter(fn: (event: string, data: unknown) => void) {
  eventEmitter = fn;
}

/** Called once from index.ts after the bridge is up, so approval prompts can
 * show the real calling app's domain instead of a placeholder string. */
export function setOriginGetter(fn: () => string) {
  originGetter = fn;
}

// One JsonRpcProvider per chain, created lazily and reused — not per
// request. Public RPC endpoints rate-limit hard on repeated connections.
const providerCache = new Map<number, JsonRpcProvider>();
function providerFor(chainId: number): JsonRpcProvider {
  let p = providerCache.get(chainId);
  if (!p) {
    const chain = getChainConfig(chainId);
    if (!chain) throw new RpcError(4902, `No RPC configured for chain ${chainId}`);
    p = new JsonRpcProvider(chain.rpcUrl, chainId);
    providerCache.set(chainId, p);
  }
  return p;
}

// Batch ids for wallet_getCallsStatus, keyed by a locally generated id since
// an EOA has no native batch concept to look one up by.
const batchStatus = new Map<string, { status: 'PENDING' | 'CONFIRMED' | 'FAILED'; receipts: unknown[] }>();

/** For the wallet's own UI to show a balance — not routed through the
 * ethProvider channel, since this is what the person sees, not what a mini
 * app requests. Returns a human-readable ETH string, e.g. "0.0142". */
export async function getDisplayBalance(): Promise<string> {
  const wallet = requireUnlockedEvm();
  const balanceWei = await providerFor(currentChainId).getBalance(wallet.address);
  const { formatEther } = await import('ethers');
  return formatEther(balanceWei);
}

/** Read-only ERC-20 allowance check — used before an approve-then-swap
 * sequence, so a token that's already approved for enough of an allowance
 * doesn't get a redundant (and gas-costing) approval every single swap. */
export async function getErc20Allowance(chainId: number, tokenAddress: string, owner: string, spender: string): Promise<bigint> {
  const { Interface } = await import('ethers');
  const iface = new Interface(['function allowance(address owner, address spender) view returns (uint256)']);
  const data = iface.encodeFunctionData('allowance', [owner, spender]);
  const result = await providerFor(chainId).call({ to: tokenAddress, data });
  return iface.decodeFunctionResult('allowance', result)[0] as bigint;
}

/** Encodes an ERC-20 approve() call — the caller broadcasts this through
 * broadcastPreparedTransaction like any other transaction. */
export async function buildErc20ApproveCalldata(spender: string, amount: bigint): Promise<string> {
  const { Interface } = await import('ethers');
  const iface = new Interface(['function approve(address spender, uint256 amount) returns (bool)']);
  return iface.encodeFunctionData('approve', [spender, amount]);
}

export function getCurrentChainName(): string {
  return getChainConfig(currentChainId)?.name ?? `Chain ${currentChainId}`;
}

/** For callers that already have their own approval step (the swap flow)
 * and just need to sign-and-broadcast an already-built transaction, without
 * going through eth_sendTransaction's own approval gate a second time. */
export async function broadcastPreparedTransaction(tx: {
  to: string;
  data: string;
  value: string;
  chainId: number;
  gasLimit?: string;
  gasPrice?: string;
  /** When true, wait for one confirmation before resolving. Needed for an
   * approve-then-swap sequence, where submitting the swap before the
   * approval is actually mined would just fail on-chain — a race the
   * caller shouldn't have to think about. */
  waitForConfirmation?: boolean;
}): Promise<string> {
  const wallet = requireUnlockedEvm().connect(providerFor(tx.chainId));
  const sent = await wallet.sendTransaction({
    to: tx.to,
    data: tx.data,
    value: tx.value,
    gasLimit: tx.gasLimit,
    gasPrice: tx.gasPrice,
  });
  if (tx.waitForConfirmation) {
    await sent.wait();
  }
  return sent.hash;
}

export async function handleEthProviderRequest(method: string, params: unknown): Promise<unknown> {
  switch (method) {
    case 'eth_getBalance': {
      const [address, blockTag] = params as [string, string?];
      const balance = await providerFor(currentChainId).getBalance(address, blockTag ?? 'latest');
      return `0x${balance.toString(16)}`;
    }

    case 'eth_chainId':
      return `0x${currentChainId.toString(16)}`;

    case 'eth_accounts': {
      if (!isUnlocked()) return [];
      return [requireUnlockedEvm().address];
    }

    case 'eth_requestAccounts': {
      if (!isUnlocked()) {
        const approved = await requestApproval({ kind: 'unlock' });
        if (!approved) throw new RpcError(ERR_USER_REJECTED, 'User rejected unlock.');
      }
      const approved = await requestApproval({ kind: 'connect', origin: currentOrigin() });
      if (!approved) throw new RpcError(ERR_USER_REJECTED, 'User rejected the connection.');
      return [requireUnlockedEvm().address];
    }

    case 'wallet_switchEthereumChain': {
      const { chainId } = params as { chainId: string };
      const id = parseInt(chainId, 16);
      if (!getChainConfig(id)) {
        throw new RpcError(4902, `Unrecognized chain ${chainId}`); // EIP-3085 "unrecognized chain" code
      }
      currentChainId = id;
      // Event shape is another unverified guess, same category as
      // swapIntent's — EIP-1193's own convention for this event is just the
      // new chainId as a hex string, so that's what's sent as `data` here;
      // how it's wrapped in the 'eth_provider_event' envelope on the way to
      // the parent hasn't been confirmed against a real Farcaster client.
      eventEmitter('chainChanged', `0x${currentChainId.toString(16)}`);
      return null;
    }

    case 'wallet_getCapabilities': {
      // Honest: this is a plain EOA signer, not a smart account. Returning
      // {} rather than claiming paymaster/atomic-batch support a real
      // 4337 wallet would have is the difference between a mini app
      // degrading gracefully and one that breaks on a false promise.
      return {};
    }

    case 'personal_sign': {
      const [messageHex, address] = params as [string, string];
      const approved = await requestApproval({ kind: 'sign', method, raw: messageHex, origin: currentOrigin() });
      if (!approved) throw new RpcError(ERR_USER_REJECTED, 'User rejected the signature request.');
      const wallet = requireUnlockedEvm();
      return wallet.signMessage(hexToBytes(messageHex));
    }

    case 'eth_signTypedData_v4': {
      const [address, typedDataJson] = params as [string, string];
      const approved = await requestApproval({ kind: 'sign', method, raw: typedDataJson, origin: currentOrigin() });
      if (!approved) throw new RpcError(ERR_USER_REJECTED, 'User rejected the signature request.');
      const wallet = requireUnlockedEvm();
      const typedData = JSON.parse(typedDataJson);
      return wallet.signTypedData(typedData.domain, typedData.types, typedData.message);
    }

    case 'eth_sendTransaction': {
      const [tx] = params as [Record<string, unknown>];
      const approved = await requestApproval({ kind: 'transaction', tx, origin: currentOrigin() });
      if (!approved) throw new RpcError(ERR_USER_REJECTED, 'User rejected the transaction.');
      const wallet = requireUnlockedEvm().connect(providerFor(currentChainId));
      try {
        const sent = await wallet.sendTransaction(tx as Record<string, unknown>);
        return sent.hash;
      } catch (e) {
        // Surface the RPC's own reason (insufficient funds, nonce too low,
        // etc.) rather than a generic failure — that's what makes this
        // debuggable from a mini app's own error toast.
        throw new RpcError(ERR_INTERNAL, e instanceof Error ? e.message : String(e));
      }
    }

    case 'wallet_sendCalls': {
      // A real EOA can't batch atomically. Being honest about that (per the
      // writeup this fork is competing with) is right, but silently
      // executing calls sequentially without saying so in the approval UI
      // is not — the approval prompt for this method must say "N separate
      // transactions" so the user isn't surprised by partial execution.
      const { calls } = params as { calls: Array<Record<string, unknown>> };
      const approved = await requestApproval({ kind: 'batch-transaction', calls, origin: currentOrigin() });
      if (!approved) throw new RpcError(ERR_USER_REJECTED, 'User rejected the batch.');

      const wallet = requireUnlockedEvm().connect(providerFor(currentChainId));
      const batchId = crypto.randomUUID();
      const receipts: unknown[] = [];
      batchStatus.set(batchId, { status: 'PENDING', receipts });

      // Sequential and stop-on-first-failure: an EOA has no atomicity to
      // fall back on, so continuing past a failed call would silently
      // execute a different set of calls than the caller asked for.
      (async () => {
        try {
          for (const call of calls) {
            const sent = await wallet.sendTransaction(call);
            const receipt = await sent.wait();
            receipts.push({ transactionHash: sent.hash, status: receipt?.status });
          }
          batchStatus.set(batchId, { status: 'CONFIRMED', receipts });
        } catch (e) {
          batchStatus.set(batchId, { status: 'FAILED', receipts });
        }
      })();

      return { id: batchId };
    }

    case 'wallet_getCallsStatus': {
      const { id } = params as { id: string };
      const entry = batchStatus.get(id);
      if (!entry) throw new RpcError(ERR_INVALID_PARAMS, `Unknown batch id ${id}`);
      return entry;
    }

    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

function currentOrigin(): string {
  return originGetter();
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  return bytes;
}
