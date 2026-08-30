import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDNodeWallet, Mnemonic } from 'ethers';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { derivePath } from 'ed25519-hd-key';

const PBKDF2_ITERATIONS = 600_000; // OWASP 2023 recommendation for PBKDF2-SHA256
const STORAGE_KEY = 'fcwallet:v1';

type StoredCiphertext = {
  kind: 'mnemonic';
  salt: string; // base64
  iv: string; // base64
  ciphertext: string; // base64
  evmAddress: string; // derived, so the UI can show an address before unlock
};

type UnlockedAccount = {
  mnemonic: string;
  evm: HDNodeWallet; // ethers signer, m/44'/60'/0'/0/0
  solana: { publicKey: Uint8Array; secretKey: Uint8Array }; // m/44'/501'/0'/0'
};

// Deliberately module-scoped, not exported: the only way out is through the
// functions below, and it's dropped on lock() or page unload.
let unlocked: UnlockedAccount | null = null;

function toB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  return bytes;
}
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
// TS's lib.dom BufferSource typing gets fussy about Uint8Array's generic
// ArrayBufferLike parameter across TS/lib versions; this narrows it back to
// what crypto.subtle actually wants at runtime (any Uint8Array works fine).
function asBufferSource(u: Uint8Array): BufferSource {
  return u as unknown as BufferSource;
}

async function deriveAesKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: asBufferSource(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function deriveSolanaKeypair(seed: Uint8Array): { publicKey: Uint8Array; secretKey: Uint8Array } {
  // m/44'/501'/0'/0' is the path Phantom, Backpack, Solflare and the rest of
  // the ecosystem standardized on for a BIP-39-seeded Solana account. Every
  // path segment is hardened, so this is a legitimate use of ed25519-hd-key
  // (ed25519 only supports hardened derivation). Using anything other than
  // this exact library/path means the same 12 words produce a DIFFERENT
  // Solana address here than in every other wallet a user might restore
  // into — a correctness bug that looks like a security bug the first time
  // someone can't find their funds.
  const seedHex = bytesToHex(seed);
  const { key } = derivePath("m/44'/501'/0'/0'", seedHex);
  const keypair = nacl.sign.keyPair.fromSeed(key);
  return { publicKey: keypair.publicKey, secretKey: keypair.secretKey };
}

export function hasStoredAccount(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== null;
}

export function isUnlocked(): boolean {
  return unlocked !== null;
}

export function getEvmAddress(): string | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  return (JSON.parse(raw) as StoredCiphertext).evmAddress;
}

/** Only available once unlocked, unlike getEvmAddress — the Solana address
 * isn't persisted alongside the ciphertext the way the EVM one is, so there's
 * nothing to show before the person types their password. */
export function getSolanaAddress(): string | null {
  if (!unlocked) return null;
  return bs58.encode(unlocked.solana.publicKey);
}

export async function createAccount(password: string): Promise<{ mnemonic: string; evmAddress: string }> {
  const mnemonic = bip39.generateMnemonic(wordlist, 128); // 12 words
  await persist(mnemonic, password);
  return { mnemonic, evmAddress: unlocked!.evm.address };
}

export async function importAccount(
  mnemonicOrPrivateKey: string,
  password: string,
): Promise<{ evmAddress: string }> {
  const trimmed = mnemonicOrPrivateKey.trim();
  if (trimmed.startsWith('0x') && trimmed.length === 66) {
    throw new Error(
      'Raw private key import is supported for the EVM side only and needs a separate storage path (no mnemonic to derive Solana from) — implement importRawKey() before enabling this in the UI.',
    );
  }
  if (!bip39.validateMnemonic(trimmed, wordlist)) {
    throw new Error('Not a valid BIP-39 mnemonic.');
  }
  await persist(trimmed, password);
  return { evmAddress: unlocked!.evm.address };
}

async function persist(mnemonic: string, password: string) {
  const seedBytes = hexToBytes(Mnemonic.fromPhrase(mnemonic).computeSeed());
  const evm = HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/60'/0'/0/0");
  const solana = deriveSolanaKeypair(seedBytes);

  unlocked = { mnemonic, evm, solana };

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(password, salt);
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: asBufferSource(iv) }, key, asBufferSource(enc.encode(mnemonic)));

  const stored: StoredCiphertext = {
    kind: 'mnemonic',
    salt: toB64(salt),
    iv: toB64(iv),
    ciphertext: toB64(ciphertext),
    evmAddress: evm.address,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
}

export async function unlock(password: string): Promise<{ evmAddress: string }> {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) throw new Error('No account stored — call createAccount() or importAccount() first.');
  const stored: StoredCiphertext = JSON.parse(raw);

  const key = await deriveAesKey(password, fromB64(stored.salt));
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: asBufferSource(fromB64(stored.iv)) },
      key,
      asBufferSource(fromB64(stored.ciphertext)),
    );
  } catch {
    throw new Error('Wrong password.'); // AES-GCM auth tag mismatch surfaces here
  }
  const mnemonic = new TextDecoder().decode(plaintext);

  const seedBytes = hexToBytes(Mnemonic.fromPhrase(mnemonic).computeSeed());
  const evm = HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/60'/0'/0/0");
  const solana = deriveSolanaKeypair(seedBytes);
  unlocked = { mnemonic, evm, solana };

  return { evmAddress: evm.address };
}

export function lock() {
  unlocked = null;
}

export function requireUnlockedEvm(): HDNodeWallet {
  if (!unlocked) throw new Error('WALLET_LOCKED');
  return unlocked.evm;
}

export function requireUnlockedSolana(): { publicKey: Uint8Array; secretKey: Uint8Array } {
  if (!unlocked) throw new Error('WALLET_LOCKED');
  return unlocked.solana;
}
