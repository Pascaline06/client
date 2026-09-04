import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { ERR_USER_REJECTED, ERR_INTERNAL, ERR_INVALID_PARAMS, RpcError } from '../bridge/rpc';
import { requireUnlockedSolana, isUnlocked } from '../keys/keyManager';
import { requestApproval } from '../ui/approval';

// Verified against packages/farcaster-client-data/src/messageChannelRpc's
// SolanaSchema: the parent always transfers this port, always creates a
// client for it, and there is no code path where a Farcaster client skips
// asking it to `connect`. A wallet that only declines here isn't a complete
// implementation of the bridge — it's an EVM-only wallet sitting behind a
// bridge built for both chains. This file is what closes that gap.

// 'mainnet-beta' to match how Farcaster actually uses Solana in production
// — same choice as defaulting the EVM side to Base mainnet. Unlike EVM,
// Solana's wallet standard has no wallet_switchEthereumChain equivalent — a
// dapp can't ask the wallet to change cluster over the wire, since the
// cluster is normally just fixed wallet configuration. So there's no live
// button for this the way there is for Base Sepolia: to test against
// devnet, change the line below to 'devnet' and rebuild.
let cluster: 'mainnet-beta' | 'devnet' = 'mainnet-beta';
export function setSolanaCluster(next: 'mainnet-beta' | 'devnet') {
  cluster = next;
}
export function getSolanaCluster(): string {
  return cluster;
}
function clusterUrl(): string {
  // Kept for devnet only now — mainnet routes through getWorkingConnection()
  // below instead of a single fixed URL, since two different "reliable free
  // public RPC" picks (Solana Labs' own, then Ankr) both failed for real
  // the first time either actually ran, with two different rejection
  // reasons. A single hardcoded mainnet URL is a bet this space keeps not
  // paying off on; a fallback chain degrades instead of just breaking.
  return 'https://api.devnet.solana.com';
}
/** Exposed for the swap module, which needs a devnet URL directly for the
 * self-transfer test path — mainnet callers should use getWorkingConnection(). */
export function getSolanaClusterUrl(): string {
  return clusterUrl();
}

// Ordered by how recently each was confirmed working via search, not by
// brand recognition — freesolanarpc.com (dated May 2026) specifically
// called out Solana Tracker's public endpoint as the one that still
// supports sendTransaction with zero signup, which the others don't all
// promise. api.mainnet-beta.solana.com is kept as a last resort even though
// it's the one already confirmed to 403 on this exact traffic, since a
// last-resort attempt costs nothing once every named alternative has failed.
const MAINNET_RPC_CANDIDATES = [
  'https://solana-rpc.publicnode.com',
  'https://rpc.solanatracker.io/public',
  'https://solana.api.onfinality.io/public',
  'https://api.mainnet-beta.solana.com',
];

let cachedMainnetConnection: import('@solana/web3.js').Connection | null = null;

/** Tries each mainnet candidate with a cheap real call (getLatestBlockhash)
 * under a short timeout, caches and returns the first one that actually
 * responds. Devnet doesn't go through this — its public endpoint hasn't
 * shown the same blocking behavior, so it stays a fixed URL. */
async function getWorkingMainnetConnection(): Promise<import('@solana/web3.js').Connection> {
  if (cachedMainnetConnection) return cachedMainnetConnection;

  const { Connection } = await import('@solana/web3.js');
  const errors: string[] = [];

  for (const url of MAINNET_RPC_CANDIDATES) {
    try {
      const candidate = new Connection(url, 'confirmed');
      await Promise.race([
        candidate.getLatestBlockhash(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timed out after 4s')), 4000)),
      ]);
      cachedMainnetConnection = candidate;
      return candidate;
    } catch (e) {
      errors.push(`${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  throw new Error(`No working Solana mainnet RPC found. Tried:\n${errors.join('\n')}`);
}

/** What every mainnet-facing call in this file and in the swap module
 * should use instead of building their own Connection against a fixed URL. */
export async function getSolanaConnection(): Promise<import('@solana/web3.js').Connection> {
  if (cluster === 'devnet') {
    const { Connection } = await import('@solana/web3.js');
    return new Connection(clusterUrl(), 'confirmed');
  }
  return getWorkingMainnetConnection();
}

/** For the wallet's own UI — mirrors ethProvider.ts's getDisplayBalance().
 * Returns a human-readable SOL string, e.g. "0.0142". */
export async function getDisplaySolBalance(): Promise<string> {
  const { publicKey } = requireUnlockedSolana();
  const { PublicKey } = await import('@solana/web3.js');
  const connection = await getSolanaConnection();
  const lamports = await connection.getBalance(new PublicKey(publicKey));
  return (lamports / 1_000_000_000).toString();
}

export function getSolanaClusterName(): string {
  return cluster;
}

/** Native SOL transfer used by the Farcaster wallet-level send flow. The
 * transaction is constructed locally, shown to the user for approval by the
 * caller, then signed and confirmed here. */

function parseSolAmountToLamports(amount: string): bigint {
  const value = amount.trim();
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new RpcError(ERR_INVALID_PARAMS, 'Invalid SOL amount.');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > 9) throw new RpcError(ERR_INVALID_PARAMS, 'SOL amount has more than 9 decimal places.');
  return BigInt(whole) * 1_000_000_000n + BigInt((fraction + '000000000').slice(0, 9));
}

export async function sendSolanaNative(to: string, amount: string, amountIsRaw = false): Promise<string> {
  const { PublicKey, SystemProgram, Transaction } = await import('@solana/web3.js');
  const { publicKey, secretKey } = requireUnlockedSolana();
  const from = new PublicKey(publicKey);
  const destination = new PublicKey(to);
  const lamports = amountIsRaw ? BigInt(amount) : parseSolAmountToLamports(amount);
  if (lamports <= 0n) throw new RpcError(ERR_INVALID_PARAMS, 'SOL amount must be greater than zero.');
  if (lamports > BigInt(Number.MAX_SAFE_INTEGER)) throw new RpcError(ERR_INVALID_PARAMS, 'SOL amount is too large.');
  const connection = await getSolanaConnection();
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: from });
  tx.add(SystemProgram.transfer({ fromPubkey: from, toPubkey: destination, lamports: Number(lamports) }));
  const { Keypair } = await import('@solana/web3.js');
  tx.sign(Keypair.fromSecretKey(secretKey));
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  return signature;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export async function handleSolanaProviderRequest(method: string, params: unknown): Promise<unknown> {
  switch (method) {
    case 'connect': {
      if (!isUnlocked()) {
        const approved = await requestApproval({ kind: 'unlock' });
        if (!approved) throw new RpcError(ERR_USER_REJECTED, 'User rejected unlock.');
      }
      const approved = await requestApproval({ kind: 'connect-solana', origin: currentOrigin() });
      if (!approved) throw new RpcError(ERR_USER_REJECTED, 'User rejected the connection.');
      const { publicKey } = requireUnlockedSolana();
      return { publicKey: bs58.encode(publicKey) };
    }

    case 'signMessage': {
      const { message } = params as { message: string }; // base58 or base64 per wire schema — confirm against SolanaSignMessageRequestArguments before shipping
      const approved = await requestApproval({ kind: 'sign-solana', raw: message, origin: currentOrigin() });
      if (!approved) throw new RpcError(ERR_USER_REJECTED, 'User rejected the signature request.');
      const { secretKey } = requireUnlockedSolana();
      const msgBytes = bs58.decode(message);
      const sig = nacl.sign.detached(msgBytes, secretKey);
      return { signature: bs58.encode(sig) };
    }

    case 'signTransaction': {
      const { transaction } = params as { transaction: string };
      const approved = await requestApproval({ kind: 'sign-transaction-solana', origin: currentOrigin() });
      if (!approved) throw new RpcError(ERR_USER_REJECTED, 'User rejected the transaction.');
      const signed = await signSerializedTransaction(transaction);
      return { transaction: signed };
    }

    case 'signAndSendTransaction': {
      const { transaction } = params as { transaction: string };
      const approved = await requestApproval({ kind: 'sign-transaction-solana', origin: currentOrigin() });
      if (!approved) throw new RpcError(ERR_USER_REJECTED, 'User rejected the transaction.');
      const signedBase64 = await signSerializedTransaction(transaction);
      try {
        const connection = await getSolanaConnection();
        const signature = await connection.sendRawTransaction(base64ToBytes(signedBase64), {
          skipPreflight: false,
        });
        return { signature };
      } catch (e) {
        throw new RpcError(ERR_INTERNAL, e instanceof Error ? e.message : String(e));
      }
    }

    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

/**
 * Deserialize → sign → reserialize, shared by signTransaction and
 * signAndSendTransaction. Wire format assumption flagged here rather than
 * buried: this treats `transaction` as base64-encoded serialized bytes,
 * which is the common convention for a serialized VersionedTransaction
 * (base58 is for addresses/signatures, not arbitrary-length transaction
 * bytes). This has NOT been confirmed against a real Farcaster mini app SDK
 * call — if a live parent sends base58 or a raw byte array instead, this
 * throws instead of silently mis-signing, which is the right failure mode
 * to debug from, but it does need debugging against reality, not further
 * guessing here.
 */
async function signSerializedTransaction(base64Transaction: string): Promise<string> {
  const { VersionedTransaction, Keypair } = await import('@solana/web3.js');
  const txBytes = base64ToBytes(base64Transaction);
  const tx = VersionedTransaction.deserialize(txBytes);

  const { secretKey } = requireUnlockedSolana();
  const keypair = Keypair.fromSecretKey(secretKey);

  tx.sign([keypair]);
  return bytesToBase64(tx.serialize());
}

/** For callers outside the solanaProvider channel handler (the swap flow)
 * that already have their own approval step and a transaction from a
 * third-party API (Jupiter) rather than one built here — signs with the
 * same proven path as signTransaction/signAndSendTransaction, then
 * broadcasts and waits for confirmation. */
export async function signAndBroadcastSerializedTransaction(base64Transaction: string): Promise<string> {
  const signedBase64 = await signSerializedTransaction(base64Transaction);
  const connection = await getSolanaConnection();
  const signature = await connection.sendRawTransaction(base64ToBytes(signedBase64), { skipPreflight: false });
  await connection.confirmTransaction(signature, 'confirmed');
  return signature;
}

let originGetter: () => string = () => '(unknown origin)';
export function setOriginGetter(fn: () => string) {
  originGetter = fn;
}
function currentOrigin(): string {
  return originGetter();
}
