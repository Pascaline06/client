import { connectToParent, WalletBridge } from './bridge/handshake';
import { handleEthProviderRequest, setOriginGetter as setEthOriginGetter, setEventEmitter as setEthEventEmitter, getDisplayBalance, getCurrentChainName, getCurrentChainNativeSymbol, sendEvmToken, broadcastPreparedTransaction, getErc20Allowance, buildErc20ApproveCalldata } from './providers/ethProvider';
import { handleSolanaProviderRequest, setOriginGetter as setSolOriginGetter, setSolanaCluster, getDisplaySolBalance, getSolanaClusterName, getSolanaConnection, signAndBroadcastSerializedTransaction, sendSolanaNative } from './providers/solanaProvider';
import { hasStoredAccount, isUnlocked, getEvmAddress, getSolanaAddress, requireUnlockedEvm } from './keys/keyManager';
import { getEvmSwapQuote, formatTokenAmount, NATIVE_TOKEN_ADDRESS } from './swap/lifi';
import { getSolanaSwapQuote, getSolanaSwapTransaction, getMintDecimals, formatSplAmount } from './swap/jupiter';
import { buildSiwfMessage } from './auth/siwf';
import { buildJfs } from './auth/jfs';
import { requestApproval } from './ui/approval';
import { getChainConfig } from './providers/chains';

// Dev-only override, never present on a real embedding: the harness
// appends ?cluster=devnet so its own Solana send-transaction test doesn't
// fight the mainnet default the same way an actual embedding never would.
const clusterParam = new URLSearchParams(window.location.search).get('cluster');
if (clusterParam === 'devnet') setSolanaCluster('devnet');

async function main() {
  let bridge: WalletBridge;
  try {
    bridge = await connectToParent({
      // TODO: lock this to the real farcaster-web origins before shipping —
      // left open during dev so the standalone demo harness (any localhost
      // port) can complete the handshake too.
    });
  } catch (e) {
    // Not embedded, or handshake failed — render the standalone UI (opened
    // directly, e.g. for testing) instead of the parent-driven one.
    renderStandalone();
    return;
  }

  // Ask the parent who's actually calling, once, up front — used to show a
  // real domain in approval prompts instead of a placeholder string. If this
  // fails (harness doesn't implement it, or a genuinely old parent), fall
  // back to a label that at least says so plainly rather than lying.
  let connectionOrigin = '(unknown app)';
  bridge.warpcast
    .request<{ domain?: string }>('get_connection_context')
    .then((ctx) => {
      if (ctx?.domain) connectionOrigin = ctx.domain;
    })
    .catch(() => {
      connectionOrigin = '(origin unavailable)';
    });
  const getConnectionOrigin = () => connectionOrigin;
  setEthOriginGetter(getConnectionOrigin);
  setSolOriginGetter(getConnectionOrigin);

  // Same unverified-envelope caveat as swap_token_result — 'eth_provider_event'
  // is a real method name confirmed from EmbeddedWallet.tsx's warpcast
  // schema, but the exact shape of its params hasn't been confirmed. This
  // wraps the event/data pair plainly rather than guessing at nested field
  // names that would just be another thing to get subtly wrong.
  setEthEventEmitter((event, data) => {
    bridge.warpcast.request('eth_provider_event', { event, data }).catch(() => {});
  });

  // Wrapping both handlers so the home screen re-renders after every
  // request, success or failure. Without this, renderHome() only ever
  // reflects whatever the state was the instant the page loaded — it never
  // finds out a later eth_requestAccounts call actually unlocked the
  // wallet, so it just sits there saying "locked" forever even after it
  // isn't. The request's own result/error still flows back to the caller
  // exactly as before; this only adds a side effect.
  bridge.registerEthProviderHandler(async (method, params) => {
    try {
      return await handleEthProviderRequest(method, params);
    } finally {
      renderHome();
    }
  });
  bridge.registerSolanaProviderHandler(async (method, params) => {
    try {
      return await handleSolanaProviderRequest(method, params);
    } finally {
      renderHome();
    }
  });

  bridge.registerWalletProviderHandler(async (method, params) => {
    switch (method) {
      case 'send_token': {
        const { sendIntent } = params as { sendIntent?: Record<string, unknown> };
        // Open the wallet UI with the send screen prefilled from sendIntent
        // (chain, contract address, amount, recipient). The person still has
        // to press send — this call only stages the screen.
        runSendFlow(sendIntent, bridge, getConnectionOrigin);
        return undefined;
      }
      case 'swap_token': {
        const { swapIntent } = params as { swapIntent?: Record<string, unknown> };
        const solanaIntent = parseSolanaSwapIntent(swapIntent);
        if (solanaIntent) {
          runSolanaSwapFlow(solanaIntent, bridge, getConnectionOrigin);
        } else {
          runSwapFlow(swapIntent, bridge, getConnectionOrigin);
        }
        return undefined;
      }
      case 'navigate': {
        const { path, params: navParams } = params as { path: string; params?: unknown };
        renderPath(path, navParams);
        return undefined;
      }
      case 'logout': {
        // Clear the unlocked-in-memory account; stored ciphertext stays
        // (that's what "log out" vs "delete wallet" should mean).
        const { lock } = await import('./keys/keyManager');
        lock();
        renderHome();
        return undefined;
      }
      case 'set_open':
      case 'refresh':
      case 'clear_preview_requests':
        // UI-state signals from the parent — no-ops until the UI layer
        // exists to react to them.
        return undefined;
      case 'sign_in_with_auth_address': {
        runSignInFlow(params as Record<string, unknown> | undefined, bridge, getConnectionOrigin);
        return undefined;
      }
      case 'silently_sign_manifest': {
        return signJfs(params as Record<string, unknown> | undefined, 'manifest');
      }
      case 'silently_sign_auth_message': {
        return signJfs(params as Record<string, unknown> | undefined, 'auth_message');
      }
      default:
        throw new Error(`Unhandled walletProvider method: ${method}`);
    }
  });

  renderHome();
}

function renderHome() {
  const root = document.getElementById('app')!;
  if (!hasStoredAccount()) {
    root.textContent = 'No wallet yet — onboarding screen not yet built.';
    return;
  }
  if (!isUnlocked()) {
    root.textContent = 'Wallet locked — unlock screen not yet built.';
    return;
  }
  const evmAddress = getEvmAddress();
  const chainName = getCurrentChainName();
  const solAddress = getSolanaAddress();
  const solCluster = getSolanaClusterName();

  const nativeSymbol = getCurrentChainNativeSymbol();
  const render = (evmBalance: string, solBalance: string) =>
    `Unlocked.\n\nEVM — ${chainName}\nAddress: ${evmAddress}\nBalance: ${evmBalance}\n\nSolana — ${solCluster}\nAddress: ${solAddress}\nBalance: ${solBalance}`;

  root.textContent = render('loading…', 'loading…');

  // Both balances are independent network calls against different chains —
  // fetch in parallel and let each fill in on its own rather than having a
  // slow Solana RPC hold up a balance the EVM side already has.
  let evmBalance = 'loading…';
  let solBalance = 'loading…';
  getDisplayBalance()
    .then((b) => (evmBalance = `${b} ${nativeSymbol}`))
    .catch((e) => (evmBalance = `failed (${e instanceof Error ? e.message : String(e)})`))
    .finally(() => (root.textContent = render(evmBalance, solBalance)));
  getDisplaySolBalance()
    .then((b) => (solBalance = `${b} SOL`))
    .catch((e) => (solBalance = `failed (${e instanceof Error ? e.message : String(e)})`))
    .finally(() => (root.textContent = render(evmBalance, solBalance)));
}
function renderStandalone() {
  const root = document.getElementById('app')!;
  root.textContent = 'Opened outside a parent frame. Standalone/demo UI not yet built.';
}
async function runSendFlow(
  rawIntent: Record<string, unknown> | undefined,
  bridge: WalletBridge,
  getOrigin: () => string,
) {
  try {
    if (!isUnlocked()) {
      const unlocked = await requestApproval({ kind: 'unlock' });
      if (!unlocked) {
        await bridge.warpcast.request('send_token_result', { success: false, reason: 'rejected' }).catch(() => {});
        return;
      }
      renderHome();
    }
    if (!rawIntent) throw new Error('send_token called with no sendIntent.');

    const recipient = String(rawIntent.recipient ?? rawIntent.to ?? rawIntent.address ?? '');
    const amount = String(rawIntent.amount ?? rawIntent.sendAmount ?? rawIntent.value ?? '');
    const token = rawIntent.tokenAddress ?? rawIntent.token ?? rawIntent.contractAddress;
    const chainId = Number(rawIntent.chainId ?? rawIntent.networkId ?? rawIntent.sellChainId ?? 0);
    const network = String(rawIntent.network ?? rawIntent.chain ?? '').toLowerCase();
    const isSolana = network.includes('solana') || network === 'svm' || rawIntent.chain === 'solana';
    const amountIsRaw = rawIntent.amountIsRaw === true || rawIntent.rawAmount === true;
    if (!recipient || !amount) throw new Error(`sendIntent shape not recognized — got keys [${Object.keys(rawIntent).join(', ')}].`);
    if (!isSolana && chainId && !getChainConfig(chainId)) throw new Error(`Unsupported EVM chain ${chainId}.`);

    const approved = await requestApproval({
      kind: 'transaction',
      tx: { to: recipient, amount, token, chainId: chainId || undefined, network: isSolana ? 'solana' : undefined },
      origin: getOrigin(),
    });
    if (!approved) {
      await bridge.warpcast.request('send_token_result', { success: false, reason: 'rejected' }).catch(() => {});
      return;
    }

    const txHash = isSolana
      ? await sendSolanaNative(recipient, amount, amountIsRaw)
      : await sendEvmToken({ to: recipient, token: token ? String(token) : undefined, amount, amountIsRaw, chainId: chainId || undefined });
    await bridge.warpcast.request('send_token_result', { success: true, txHash }).catch(() => {});
    renderHome();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('Send failed:', message);
    await bridge.warpcast.request('send_token_result', { success: false, reason: 'error', error: message }).catch(() => {});
  }
}

/**
 * swapIntent's real field names haven't been confirmed against a live
 * Farcaster mini app SDK call — a search for the actual schema came up
 * empty. This accepts a couple of plausible key-name variants and throws a
 * specific, readable error if none match, rather than silently defaulting
 * to values that would swap the wrong token or amount. Update this against
 * whatever a real intent object actually looks like once one's been seen.
 */
function parseSwapIntent(intent: Record<string, unknown> | undefined): {
  fromChainId: number;
  toChainId: number;
  fromToken: string;
  toToken: string;
  fromAmount: string;
} {
  if (!intent) throw new Error('swap_token called with no swapIntent.');
  const fromChainId = Number(intent.sellChainId ?? intent.fromChainId ?? intent.chainId);
  const toChainId = Number(intent.buyChainId ?? intent.toChainId ?? intent.chainId);
  const fromToken = String(intent.sellToken ?? intent.fromToken ?? '');
  const toToken = String(intent.buyToken ?? intent.toToken ?? '');
  const fromAmount = String(intent.sellAmount ?? intent.fromAmount ?? '');
  if (!fromChainId || !toChainId || !fromToken || !toToken || !fromAmount) {
    throw new Error(
      `swapIntent shape not recognized — got keys [${Object.keys(intent).join(', ')}], none matched the expected sellToken/buyToken/sellAmount or fromToken/toToken/fromAmount patterns. This needs updating against a real intent object.`,
    );
  }
  return { fromChainId, toChainId, fromToken, toToken, fromAmount };
}

async function runSwapFlow(
  rawIntent: Record<string, unknown> | undefined,
  bridge: WalletBridge,
  getOrigin: () => string,
) {
  try {
    // Gate on unlock FIRST — otherwise this fetches a real quote, shows a
    // real approval sheet, and only discovers the wallet was locked after
    // the person already tapped approve, which is a worse failure than
    // just asking for the password up front like every other flow does.
    if (!isUnlocked()) {
      const unlocked = await requestApproval({ kind: 'unlock' });
      if (!unlocked) {
        await bridge.warpcast.request('swap_token_result', { success: false, reason: 'rejected' }).catch(() => {});
        return;
      }
      renderHome();
    }

    const intent = parseSwapIntent(rawIntent);
    const isNative = intent.fromToken.toLowerCase() === NATIVE_TOKEN_ADDRESS || intent.fromToken.toLowerCase() === 'native';
    const fromTokenAddress = isNative ? NATIVE_TOKEN_ADDRESS : intent.fromToken;

    const address = getEvmAddress();
    if (!address) throw new Error('No EVM account available to quote from.');

    const quote = await getEvmSwapQuote({
      fromChain: intent.fromChainId,
      toChain: intent.toChainId,
      fromToken: fromTokenAddress,
      toToken: intent.toToken,
      fromAmount: intent.fromAmount,
      fromAddress: address,
    });

    // Non-native tokens need an on-chain allowance before LI.FI's contract
    // can move them. Check first — an already-sufficient allowance from a
    // prior swap shouldn't cost the person a second approval transaction
    // and a second gas fee for no reason.
    if (!isNative) {
      const spender = quote.estimate.approvalAddress;
      const needed = BigInt(quote.estimate.fromAmount);
      const current = await getErc20Allowance(intent.fromChainId, fromTokenAddress, address, spender);

      if (current < needed) {
        const approvedAllowance = await requestApproval({
          kind: 'approve-token',
          tokenSymbol: quote.action.fromToken.symbol,
          spender,
          origin: getOrigin(),
        });
        if (!approvedAllowance) {
          await bridge.warpcast.request('swap_token_result', { success: false, reason: 'rejected' }).catch(() => {});
          return;
        }
        const approveData = await buildErc20ApproveCalldata(spender, needed);
        // Waits for confirmation on purpose — submitting the swap before
        // this is actually mined would just fail on-chain.
        await broadcastPreparedTransaction({
          to: fromTokenAddress,
          data: approveData,
          value: '0x0',
          chainId: intent.fromChainId,
          waitForConfirmation: true,
        });
      }
    }

    const fromDisplay = formatTokenAmount(quote.estimate.fromAmount, quote.action.fromToken.decimals);
    const toMinDisplay = formatTokenAmount(quote.estimate.toAmountMin, quote.action.toToken.decimals);

    const approved = await requestApproval({
      kind: 'swap',
      fromSymbol: quote.action.fromToken.symbol,
      toSymbol: quote.action.toToken.symbol,
      fromAmountDisplay: fromDisplay,
      toAmountMinDisplay: toMinDisplay,
      via: 'LI.FI',
      origin: getOrigin(),
    });

    if (!approved) {
      await bridge.warpcast.request('swap_token_result', { success: false, reason: 'rejected' }).catch(() => {});
      return;
    }

    const txHash = await broadcastPreparedTransaction({
      to: quote.transactionRequest.to,
      data: quote.transactionRequest.data,
      value: quote.transactionRequest.value,
      chainId: quote.transactionRequest.chainId,
      gasLimit: quote.transactionRequest.gasLimit,
      gasPrice: quote.transactionRequest.gasPrice,
      waitForConfirmation: true,
    });

    // Wire format of swap_token_result is the same kind of unverified
    // assumption as swapIntent above — this is a reasonable guess at the
    // shape, not a confirmed one.
    await bridge.warpcast.request('swap_token_result', { success: true, txHash }).catch(() => {});
    renderHome();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('Swap failed:', message);
    await bridge.warpcast
      .request('swap_token_result', { success: false, reason: 'error', error: message })
      .catch(() => {});
  }
}

/**
 * Detects a Solana-targeted swapIntent and returns its parsed fields, or
 * null if this doesn't look like one — same defensive, unverified-schema
 * situation as parseSwapIntent above, compounded by not even knowing what
 * field would distinguish a Solana intent from an EVM one. Guesses at a
 * chain/network hint field containing "solana" or "svm"; falls through to
 * the EVM parser otherwise, which will produce its own clear error if
 * neither shape matches.
 */
function parseSolanaSwapIntent(
  intent: Record<string, unknown> | undefined,
): { inputMint: string; outputMint: string; amount: string } | null {
  if (!intent) return null;
  const chainHint = String(intent.chain ?? intent.network ?? intent.sellChainId ?? intent.fromChainId ?? '').toLowerCase();
  if (!chainHint.includes('solana') && chainHint !== 'svm') return null;

  const inputMint = String(intent.sellToken ?? intent.fromToken ?? intent.inputMint ?? '');
  const outputMint = String(intent.buyToken ?? intent.toToken ?? intent.outputMint ?? '');
  const amount = String(intent.sellAmount ?? intent.fromAmount ?? intent.amount ?? '');
  if (!inputMint || !outputMint || !amount) return null;
  return { inputMint, outputMint, amount };
}

async function runSolanaSwapFlow(
  intent: { inputMint: string; outputMint: string; amount: string },
  bridge: WalletBridge,
  getOrigin: () => string,
) {
  try {
    if (!isUnlocked()) {
      const unlocked = await requestApproval({ kind: 'unlock' });
      if (!unlocked) {
        await bridge.warpcast.request('swap_token_result', { success: false, reason: 'rejected' }).catch(() => {});
        return;
      }
      renderHome();
    }

    const address = getSolanaAddress();
    if (!address) throw new Error('No Solana account available to quote from.');

    const quote = await getSolanaSwapQuote({
      inputMint: intent.inputMint,
      outputMint: intent.outputMint,
      amount: intent.amount,
    });

    const solConnection = await getSolanaConnection();
    const [inputDecimals, outputDecimals] = await Promise.all([
      getMintDecimals(solConnection, quote.inputMint),
      getMintDecimals(solConnection, quote.outputMint),
    ]);

    const approved = await requestApproval({
      kind: 'swap',
      fromSymbol: shortenMint(quote.inputMint),
      toSymbol: shortenMint(quote.outputMint),
      fromAmountDisplay: formatSplAmount(quote.inAmount, inputDecimals),
      toAmountMinDisplay: formatSplAmount(quote.otherAmountThreshold, outputDecimals),
      via: 'Jupiter',
      origin: getOrigin(),
    });
    if (!approved) {
      await bridge.warpcast.request('swap_token_result', { success: false, reason: 'rejected' }).catch(() => {});
      return;
    }

    const swapTransaction = await getSolanaSwapTransaction({ quote, userPublicKey: address });
    const signature = await signAndBroadcastSerializedTransaction(swapTransaction);

    await bridge.warpcast.request('swap_token_result', { success: true, txHash: signature }).catch(() => {});
    renderHome();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('Solana swap failed:', message);
    await bridge.warpcast
      .request('swap_token_result', { success: false, reason: 'error', error: message })
      .catch(() => {});
  }
}

/** Jupiter's quote doesn't include token symbols (unlike LI.FI's), and a
 * proper symbol lookup would be a third unverified API — showing a
 * shortened mint address is honest about what's actually known here rather
 * than guessing at a display name. */
function shortenMint(mint: string): string {
  return mint.length > 8 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint;
}

/**
 * SIWF's core is confirmed (a plain SIWE message + personal_sign — see
 * src/auth/siwf.ts's header comment), but this wallet has no way to know
 * whether its own address has actually been registered on-chain as an auth
 * address for anyone's fid. It signs a syntactically correct message either
 * way; whether that signature verifies as anything meaningful is entirely
 * up to state this wallet can't see. The approval sheet says this plainly
 * rather than implying a successful signature means a successful sign-in.
 */
async function runSignInFlow(
  rawParams: Record<string, unknown> | undefined,
  bridge: WalletBridge,
  getOrigin: () => string,
) {
  try {
    if (!isUnlocked()) {
      const unlocked = await requestApproval({ kind: 'unlock' });
      if (!unlocked) {
        await bridge.warpcast.request('sign_in_with_auth_address_result', { success: false, reason: 'rejected' }).catch(() => {});
        return;
      }
      renderHome();
    }

    const nonce = String(rawParams?.nonce ?? '');
    if (!nonce) throw new Error('sign_in_with_auth_address called with no nonce.');

    const origin = getOrigin();
    const address = getEvmAddress();
    if (!address) throw new Error('No EVM account available to sign in with.');

    const message = buildSiwfMessage({
      domain: origin,
      address,
      uri: `https://${origin}`,
      signIn: {
        nonce,
        notBefore: rawParams?.notBefore as string | undefined,
        expirationTime: rawParams?.expirationTime as string | undefined,
      },
    });

    const approved = await requestApproval({ kind: 'sign-in-farcaster', origin });
    if (!approved) {
      await bridge.warpcast.request('sign_in_with_auth_address_result', { success: false, reason: 'rejected' }).catch(() => {});
      return;
    }

    const signature = await requireUnlockedEvm().signMessage(message);

    // SignInResult's confirmed shape (from the miniapps SDK reference) is
    // exactly { message, signature } — unlike swap_token_result and
    // eth_provider_event, this envelope is NOT a guess.
    await bridge.warpcast
      .request('sign_in_with_auth_address_result', { success: true, message, signature })
      .catch(() => {});
  } catch (e) {
    const errMessage = e instanceof Error ? e.message : String(e);
    console.error('Sign-in failed:', errMessage);
    await bridge.warpcast
      .request('sign_in_with_auth_address_result', { success: false, reason: 'error', error: errMessage })
      .catch(() => {});
  }
}

/**
 * Both silently_sign_* methods return a signature directly rather than
 * reporting a result asynchronously — there's no
 * silently_sign_manifest_result / silently_sign_auth_message_result
 * counterpart on the warpcast channel, unlike send_token/swap_token/
 * sign_in_with_auth_address, which is consistent with "silently" meaning
 * no UI interaction of any kind, including no approval sheet. Worth being
 * clear-eyed about: this means any embedding client can request an
 * identity-attesting signature with zero user confirmation. That's how the
 * protocol appears to name and design this method, not a corner being cut
 * here — but it's a real trust boundary, not a small detail.
 *
 * Both sign a JSON Farcaster Signature with type 'auth' — this wallet's
 * EVM address acting as a registered auth address, with the same caveat as
 * sign_in_with_auth_address: whether it's actually registered that way is
 * state this wallet has no way to see.
 *
 * fid must come from the caller — this wallet has no concept of a
 * Farcaster fid on its own; nothing here tracks one. The manifest payload
 * shape (`{ domain }`) is confirmed directly from Farcaster's own spec
 * example. The auth_message payload shape is NOT confirmed anywhere —
 * this accepts whatever payload object the caller provides under a
 * `payload` field, falling back to the same `{ domain }` shape as a
 * reasonable guess if none is given.
 */
async function signJfs(
  params: Record<string, unknown> | undefined,
  kind: 'manifest' | 'auth_message',
): Promise<{ header: string; payload: string; signature: string }> {
  if (!isUnlocked()) {
    throw new Error(
      `silently_sign_${kind}: wallet is locked — "silently" means no approval prompt, which also means no unlock prompt, so this fails rather than popping a dialog.`,
    );
  }
  const fid = Number(params?.fid);
  if (!fid) throw new Error(`silently_sign_${kind}: called with no numeric fid.`);

  const address = getEvmAddress();
  if (!address) throw new Error('No EVM account available to sign with.');

  const payload = (params?.payload as Record<string, unknown> | undefined) ?? { domain: String(params?.domain ?? '') };

  return buildJfs({
    header: { fid, type: 'auth', key: address },
    payload,
    sign: (message) => requireUnlockedEvm().signMessage(message),
  });
}

function renderPath(path: string, params: unknown) {
  console.log('TODO renderPath', path, params);
}

main();
