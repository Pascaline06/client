import { createRpcClient, createRpcServer } from './rpc';

// The parent (apps/farcaster-web EmbeddedWallet.tsx) does this, verified by
// reading the file directly:
//
//   1. Renders <iframe src="{WALLET_ORIGIN}/?id={id}">, id = parent-generated uuid.
//   2. Has a window 'message' listener armed from mount, waiting for
//      { fcinit: 'v1', id } echoed back from that exact iframe's contentWindow.
//   3. On receiving that ACK, calls initialize(): posts a theme message, then
//      posts { fcinit: 'v1', id } a second time — this one carrying 4
//      transferable MessagePorts, in this exact order:
//        [ initChannel.port2, walletChannel.port2, ethProviderChannel.port2, solanaProviderChannel.port2 ]
//      and immediately starts its own port1 side of wallet/eth/solana (init
//      port1 is deliberately held back until an authToken exists).
//
// The wallet side (this file) is the mirror image. Steps 4-5 below are ours.

export type WalletBridge = {
  /** Client — the wallet calls INTO the parent on this channel. */
  warpcast: ReturnType<typeof createRpcClient>;
  /** Server — the parent calls INTO the wallet on this channel. Wire up your
   * handler with onWalletProviderRequest before the port starts, since a
   * MessagePort queues nothing until start() and the parent may call the
   * instant ports are transferred. */
  registerWalletProviderHandler: (
    handler: (method: string, params: unknown) => Promise<unknown>,
  ) => void;
  /** Client — the wallet asks the parent for an auth token via 'auth'. */
  auth: ReturnType<typeof createRpcClient>;
  registerEthProviderHandler: (
    handler: (method: string, params: unknown) => Promise<unknown>,
  ) => void;
  registerSolanaProviderHandler: (
    handler: (method: string, params: unknown) => Promise<unknown>,
  ) => void;
};

/**
 * Call this once, as early as possible (before any await), from the wallet's
 * entry point. It resolves once the parent has completed the handshake and
 * handed over all four ports.
 */
export function connectToParent(opts?: {
  /** Restrict which parent origins may complete a handshake. Leave undefined
   * to accept any origin (needed if this wallet is meant to be embeddable by
   * arbitrary client forks) — the id round-trip is still required either way,
   * so a page that didn't get the id from the initial navigation can't
   * complete the handshake even without an origin check. */
  allowedOrigins?: string[];
}): Promise<WalletBridge> {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');
  if (!id) {
    return Promise.reject(new Error('Missing ?id= — this page must be opened as the embedded wallet iframe, not directly.'));
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    function onSecondMessage(event: MessageEvent) {
      if (opts?.allowedOrigins && !opts.allowedOrigins.includes(event.origin)) return;
      const data = event.data as { fcinit?: string; id?: string } | undefined;
      if (!data || data.fcinit !== 'v1' || data.id !== id) return;
      if (!event.ports || event.ports.length !== 4) return; // this is the ACK's own echo, not the port transfer — ignore

      window.removeEventListener('message', onSecondMessage);
      settled = true;

      const [initPort, walletPort, ethPort, solPort] = event.ports;

      const auth = createRpcClient('init', initPort);
      const warpcast = createRpcClient('warpcast', walletPort);

      let walletProviderHandler: ((m: string, p: unknown) => Promise<unknown>) | null = null;
      let ethProviderHandler: ((m: string, p: unknown) => Promise<unknown>) | null = null;
      let solanaProviderHandler: ((m: string, p: unknown) => Promise<unknown>) | null = null;

      createRpcServer('walletProvider', walletPort, async (m, p) => {
        if (!walletProviderHandler) throw new Error('walletProvider handler not registered');
        return walletProviderHandler(m, p);
      });
      createRpcServer('ethProvider', ethPort, async (m, p) => {
        if (!ethProviderHandler) throw new Error('ethProvider handler not registered');
        return ethProviderHandler(m, p);
      });
      createRpcServer('solanaProvider', solPort, async (m, p) => {
        if (!solanaProviderHandler) throw new Error('solanaProvider handler not registered');
        return solanaProviderHandler(m, p);
      });

      // Ports queue nothing until start() — call it once handlers can
      // possibly already be registered by the caller in the same tick.
      initPort.start();
      walletPort.start();
      ethPort.start();
      solPort.start();

      resolve({
        warpcast,
        auth,
        registerWalletProviderHandler: (h) => (walletProviderHandler = h),
        registerEthProviderHandler: (h) => (ethProviderHandler = h),
        registerSolanaProviderHandler: (h) => (solanaProviderHandler = h),
      });
    }

    window.addEventListener('message', onSecondMessage);

    // Step 2: ACK, echoing the id we were given. No ports yet.
    window.parent.postMessage({ fcinit: 'v1', id }, '*');

    // If the parent never responds (opened directly, wrong origin, etc.)
    // don't hang forever.
    setTimeout(() => {
      if (!settled) {
        window.removeEventListener('message', onSecondMessage);
        reject(new Error('Handshake with parent timed out after 10s.'));
      }
    }, 10_000);
  });
}
