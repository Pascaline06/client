import { createRpcClient, createRpcServer } from '../bridge/rpc';

// This file plays the PARENT's role — the mirror image of
// bridge/handshake.ts, built by re-reading the same source
// (EmbeddedWallet.tsx's createWalletBridge + initialize()) but from the
// other side of the wire. Its only job is to give you something real to
// click against; it is not meant to become part of the shipped wallet.

const WALLET_ORIGIN = window.location.origin; // same origin in dev — the harness and the wallet are served by the same esbuild server

function uuid() {
  return crypto.randomUUID();
}

function log(msg: string, data?: unknown) {
  const el = document.getElementById('log')!;
  const line = document.createElement('div');
  const ts = new Date().toLocaleTimeString();
  line.textContent = data !== undefined ? `[${ts}] ${msg} ${JSON.stringify(data)}` : `[${ts}] ${msg}`;
  el.prepend(line);
}

let bridge: {
  ethClient: ReturnType<typeof createRpcClient>;
  solClient: ReturnType<typeof createRpcClient>;
  walletProviderClient: ReturnType<typeof createRpcClient>;
} | null = null;

function loadWalletAndTransferPorts() {
  const id = uuid();
  const iframe = document.getElementById('wallet-frame') as HTMLIFrameElement;
  // Which Solana cluster to load the wallet with is now a checkbox in the
  // page, not a blanket default — Jupiter only ever routes against mainnet
  // liquidity (the swap test's hardcoded USDC mint doesn't exist as a valid
  // mint account on devnet at all), while the self-transfer test needs
  // devnet specifically so it doesn't cost anything real. One fixed default
  // broke whichever test it didn't match. The real embedded wallet, opened
  // by an actual Farcaster client, never gets this param either way and
  // stays on mainnet-beta as shipped.
  const wantsDevnet = (document.getElementById('cluster-devnet') as HTMLInputElement)?.checked;
  iframe.src = `${WALLET_ORIGIN}/?id=${id}${wantsDevnet ? '&cluster=devnet' : ''}`;

  function onAck(event: MessageEvent) {
    if (event.source !== iframe.contentWindow) return;
    const data = event.data as { fcinit?: string; id?: string } | undefined;
    if (!data || data.fcinit !== 'v1' || data.id !== id) return;
    if (event.ports && event.ports.length > 0) return; // this is the ACK, not a port-carrying message — ignore anything with ports here

    log('received ACK from wallet iframe, transferring ports');
    window.removeEventListener('message', onAck);
    transferPorts(iframe, id);
  }
  window.addEventListener('message', onAck);
  log('iframe pointed at wallet, waiting for its ACK', { id });
}

function transferPorts(iframe: HTMLIFrameElement, id: string) {
  const initChannel = new MessageChannel();
  const walletChannel = new MessageChannel();
  const ethChannel = new MessageChannel();
  const solChannel = new MessageChannel();

  // Parent is SERVER for 'init' (handles 'auth') and 'warpcast', CLIENT for
  // 'walletProvider' (same port as 'warpcast'), 'ethProvider', 'solanaProvider'.
  createRpcServer('init', initChannel.port1, async (method) => {
    log('wallet called init.' + method);
    if (method === 'auth') return { authToken: 'demo-token', siwfMessage: '', siwfSignature: '' };
    throw new Error('unhandled init method: ' + method);
  });

  createRpcServer('warpcast', walletChannel.port1, async (method, params) => {
    log('wallet called warpcast.' + method, params);
    switch (method) {
      case 'get_connection_context':
        return { domain: 'demo-harness.local', iconUrl: undefined };
      case 'open_wallet':
      case 'close_wallet':
      case 'eth_provider_event':
      case 'connected':
      case 'send_token_result':
      case 'swap_token_result':
      case 'sign_in_with_auth_address_result':
      case 'report_transaction_state':
      case 'navigate':
        return undefined;
      default:
        return undefined;
    }
  });

  const walletProviderClient = createRpcClient('walletProvider', walletChannel.port1);
  const ethClient = createRpcClient('ethProvider', ethChannel.port1);
  const solClient = createRpcClient('solanaProvider', solChannel.port1);

  iframe.contentWindow?.postMessage({ type: 'theme', theme: 'light' }, '*');
  iframe.contentWindow?.postMessage({ fcinit: 'v1', id }, '*', [
    initChannel.port2,
    walletChannel.port2,
    ethChannel.port2,
    solChannel.port2,
  ]);

  initChannel.port1.start();
  walletChannel.port1.start();
  ethChannel.port1.start();
  solChannel.port1.start();

  bridge = { ethClient, solClient, walletProviderClient };
  log('ports transferred — bridge ready, buttons below are now live');
  (document.getElementById('actions') as HTMLElement).style.display = 'block';
}

async function call(label: string, fn: () => Promise<unknown>) {
  try {
    const result = await fn();
    log(`✅ ${label}`, result);
  } catch (e) {
    log(`❌ ${label} — ${e instanceof Error ? e.message : String(e)}`);
  }
}

function wireButtons() {
  document.getElementById('btn-load')!.addEventListener('click', loadWalletAndTransferPorts);

  document.getElementById('btn-chainid')!.addEventListener('click', () =>
    call('eth_chainId', () => bridge!.ethClient.request('eth_chainId')),
  );
  document.getElementById('btn-accounts')!.addEventListener('click', () =>
    call('eth_accounts', () => bridge!.ethClient.request('eth_accounts')),
  );
  document.getElementById('btn-request-accounts')!.addEventListener('click', () =>
    call('eth_requestAccounts', () => bridge!.ethClient.request('eth_requestAccounts')),
  );
  document.getElementById('btn-sign')!.addEventListener('click', () =>
    call('personal_sign', () =>
      bridge!.ethClient.request('personal_sign', ['0x48656c6c6f2066726f6d20746865206861726e657373', '0x0']),
    ),
  );
  document.getElementById('btn-sol-connect')!.addEventListener('click', () =>
    call('solana connect', () => bridge!.solClient.request('connect')),
  );
  document.getElementById('btn-sol-sign-message')!.addEventListener('click', () =>
    call('solana signMessage', () =>
      bridge!.solClient.request('signMessage', {
        // "hello" base58-encoded — signMessage's wire format per the schema
        // comment in solanaProvider.ts is base58, unlike the transaction
        // methods below which use base64.
        message: 'Cn8eVZg', // base58 for the ASCII bytes of "hello"
      }),
    ),
  );
  document.getElementById('btn-send-token')!.addEventListener('click', () =>
    call('send_token (walletProvider)', () =>
      bridge!.walletProviderClient.request('send_token', {
        sendIntent: { chain: 'base', ca: 'eth', amount: '0.001' },
      }),
    ),
  );
  document.getElementById('btn-switch-testnet')!.addEventListener('click', () =>
    call('wallet_switchEthereumChain -> Base Sepolia', () =>
      bridge!.ethClient.request('wallet_switchEthereumChain', { chainId: '0x14a34' }), // 84532
    ),
  );
  document.getElementById('btn-send-tx')!.addEventListener('click', async () => {
    const accounts = (await bridge!.ethClient.request('eth_accounts')) as string[];
    if (!accounts[0]) {
      log('❌ eth_sendTransaction — no unlocked account, run eth_requestAccounts first');
      return;
    }
    call('eth_sendTransaction (0 ETH to self, Base Sepolia)', () =>
      bridge!.ethClient.request('eth_sendTransaction', [
        { from: accounts[0], to: accounts[0], value: '0x0' },
      ]),
    );
  });

  document.getElementById('btn-sol-send')!.addEventListener('click', async () => {
    try {
      const { publicKey } = (await bridge!.solClient.request('connect')) as { publicKey: string };
      const { Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } = await import(
        '@solana/web3.js'
      );
      // Devnet regardless of what the wallet itself is configured for —
      // this only builds the unsigned transaction. If the wallet's own
      // `cluster` (in solanaProvider.ts) is still 'mainnet-beta', signing
      // will succeed but broadcasting will fail, since a devnet blockhash
      // isn't valid on mainnet — that mismatch, if you hit it, is exactly
      // why the wallet's cluster is a source-level setting rather than
      // something this harness can flip for you.
      const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
      const payer = new PublicKey(publicKey);
      const { blockhash } = await connection.getLatestBlockhash();
      const message = new TransactionMessage({
        payerKey: payer,
        recentBlockhash: blockhash,
        instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 0 })],
      }).compileToV0Message();
      const unsignedTx = new VersionedTransaction(message);
      const base64Tx = btoa(String.fromCharCode(...unsignedTx.serialize()));

      await call('solana signAndSendTransaction (devnet)', () =>
        bridge!.solClient.request('signAndSendTransaction', { transaction: base64Tx }),
      );
    } catch (e) {
      log(`❌ solana send setup — ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  document.getElementById('btn-swap')!.addEventListener('click', () =>
    call('swap_token (walletProvider) — 0.001 ETH -> USDC on Base', () =>
      bridge!.walletProviderClient.request('swap_token', {
        swapIntent: {
          sellChainId: 8453,
          buyChainId: 8453,
          sellToken: '0x0000000000000000000000000000000000000000', // native ETH
          buyToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
          sellAmount: '1000000000000000', // 0.001 ETH in wei
        },
      }),
    ),
  );

  document.getElementById('btn-swap-solana')!.addEventListener('click', () =>
    call('swap_token (walletProvider) — 0.001 SOL -> USDC (Solana mainnet)', () =>
      bridge!.walletProviderClient.request('swap_token', {
        swapIntent: {
          chain: 'solana',
          sellToken: 'So11111111111111111111111111111111111111112', // wrapped SOL mint
          buyToken: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC on Solana mainnet
          sellAmount: '1000000', // 0.001 SOL in lamports (9 decimals)
        },
      }),
    ),
  );

  document.getElementById('btn-signin')!.addEventListener('click', () =>
    call('sign_in_with_auth_address (walletProvider)', () =>
      bridge!.walletProviderClient.request('sign_in_with_auth_address', {
        nonce: Math.random().toString(36).slice(2, 12),
      }),
    ),
  );

  document.getElementById('btn-sign-manifest')!.addEventListener('click', () =>
    call('silently_sign_manifest (walletProvider) — direct return, no approval UI', () =>
      bridge!.walletProviderClient.request('silently_sign_manifest', {
        fid: 12345,
        domain: 'demo-harness.local',
      }),
    ),
  );

  document.getElementById('btn-sign-auth-message')!.addEventListener('click', () =>
    call('silently_sign_auth_message (walletProvider) — direct return, no approval UI', () =>
      bridge!.walletProviderClient.request('silently_sign_auth_message', {
        fid: 12345,
        payload: { purpose: 'test-auth-message', issuedAt: new Date().toISOString() },
      }),
    ),
  );
}

wireButtons();
