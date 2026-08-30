import { hasStoredAccount, unlock as unlockKeyManager, createAccount } from '../keys/keyManager';

// One approval surface for every signature, connection, and transaction
// request, regardless of which channel (eth or solana) it came from. Two
// rules that matter more than the UI polish:
//
//   1. A decline must be distinguishable from a crash. Callers translate a
//      `false` return into EIP-1193 4001 for EVM callers; Solana callers
//      should do the equivalent for whatever error shape the mini app SDK
//      expects there.
//   2. This function must not resolve on its own. It renders a prompt and
//      waits for an explicit tap — no timeout-to-approve, ever, even for a
//      "read-only" looking method like connect.

export type ApprovalRequest =
  | { kind: 'unlock' }
  | { kind: 'connect'; origin: string }
  | { kind: 'connect-solana'; origin: string }
  | { kind: 'sign'; method: string; raw: string; origin: string }
  | { kind: 'sign-solana'; raw: string; origin: string }
  | { kind: 'sign-transaction-solana'; origin: string }
  | { kind: 'transaction'; tx: Record<string, unknown>; origin: string }
  | { kind: 'batch-transaction'; calls: Array<Record<string, unknown>>; origin: string }
  | {
      kind: 'swap';
      fromSymbol: string;
      toSymbol: string;
      fromAmountDisplay: string;
      toAmountMinDisplay: string;
      via: string;
      origin: string;
    }
  | { kind: 'approve-token'; tokenSymbol: string; spender: string; origin: string }
  | { kind: 'sign-in-farcaster'; origin: string };

let overlayEl: HTMLDivElement | null = null;

function ensureOverlay(): HTMLDivElement {
  if (overlayEl) return overlayEl;
  const el = document.createElement('div');
  el.id = 'approval-overlay';
  Object.assign(el.style, {
    position: 'fixed',
    inset: '0',
    background: 'rgba(0,0,0,0.5)',
    display: 'none',
    alignItems: 'flex-end',
    justifyContent: 'center',
    zIndex: '999999',
    fontFamily: 'system-ui, sans-serif',
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(el);
  overlayEl = el;
  return el;
}

function panel(): HTMLDivElement {
  const p = document.createElement('div');
  Object.assign(p.style, {
    background: '#fff',
    borderRadius: '16px 16px 0 0',
    padding: '20px',
    width: '100%',
    maxWidth: '420px',
    boxSizing: 'border-box',
  } satisfies Partial<CSSStyleDeclaration>);
  return p;
}

function title(text: string): HTMLHeadingElement {
  const h = document.createElement('h3');
  h.textContent = text;
  h.style.margin = '0 0 8px';
  return h;
}

function subtitle(text: string): HTMLParagraphElement {
  const p = document.createElement('p');
  p.textContent = text;
  Object.assign(p.style, { margin: '0 0 16px', color: '#555', fontSize: '14px', wordBreak: 'break-all' });
  return p;
}

function buttonRow(onApprove: () => void, onReject: () => void, approveLabel = 'Approve'): HTMLDivElement {
  const row = document.createElement('div');
  Object.assign(row.style, { display: 'flex', gap: '8px' });

  const reject = document.createElement('button');
  reject.textContent = 'Reject';
  Object.assign(reject.style, buttonStyle('#eee', '#111'));
  reject.onclick = onReject;

  const approve = document.createElement('button');
  approve.textContent = approveLabel;
  Object.assign(approve.style, buttonStyle('#111', '#fff'));
  approve.onclick = onApprove;

  row.appendChild(reject);
  row.appendChild(approve);
  return row;
}

function buttonStyle(bg: string, fg: string): Partial<CSSStyleDeclaration> {
  return {
    flex: '1',
    padding: '12px',
    borderRadius: '8px',
    border: 'none',
    background: bg,
    color: fg,
    fontSize: '15px',
    fontWeight: '600',
  };
}

function show(content: HTMLElement) {
  const overlay = ensureOverlay();
  overlay.innerHTML = '';
  overlay.appendChild(content);
  overlay.style.display = 'flex';
}
function hide() {
  if (overlayEl) overlayEl.style.display = 'none';
}

export async function requestApproval(req: ApprovalRequest): Promise<boolean> {
  if (req.kind === 'unlock') {
    return promptUnlock();
  }
  return new Promise((resolve) => {
    const p = panel();
    p.appendChild(title(titleFor(req)));
    p.appendChild(subtitle(subtitleFor(req)));
    p.appendChild(
      buttonRow(
        () => {
          hide();
          resolve(true);
        },
        () => {
          hide();
          resolve(false);
        },
      ),
    );
    show(p);
  });
}

function titleFor(req: ApprovalRequest): string {
  switch (req.kind) {
    case 'connect':
    case 'connect-solana':
      return 'Connect to this app?';
    case 'sign':
    case 'sign-solana':
      return 'Signature request';
    case 'sign-transaction-solana':
      return 'Approve transaction';
    case 'transaction':
      return 'Send transaction';
    case 'batch-transaction':
      return `Send ${req.calls.length} transactions`;
    case 'swap':
      return `Swap ${req.fromSymbol} for ${req.toSymbol}`;
    case 'approve-token':
      return `Allow spending ${req.tokenSymbol}?`;
    case 'sign-in-farcaster':
      return `Sign in with Farcaster?`;
    default:
      return 'Approval required';
  }
}

function subtitleFor(req: ApprovalRequest): string {
  switch (req.kind) {
    case 'connect':
    case 'connect-solana':
      return `${req.origin} wants to see your address and request signatures.`;
    case 'sign':
      return `${req.origin} — ${req.method}\n${req.raw}`;
    case 'sign-solana':
      return `${req.origin} wants you to sign a message:\n${req.raw}`;
    case 'sign-transaction-solana':
      return `${req.origin} wants you to sign a transaction.`;
    case 'transaction':
      return `${req.origin} — ${JSON.stringify(req.tx)}`;
    case 'batch-transaction':
      return `${req.origin} — these will execute as ${req.calls.length} separate transactions, not one atomic call, since this is a plain account rather than a smart wallet.`;
    case 'swap':
      return `${req.origin} — send ${req.fromAmountDisplay} ${req.fromSymbol}, receive at least ${req.toAmountMinDisplay} ${req.toSymbol} (worst case with slippage). Executed as one on-chain transaction via ${req.via}.`;
    case 'approve-token':
      return `${req.origin} needs permission to move your ${req.tokenSymbol} in order to swap it. This grants that contract (${req.spender}) an allowance — a separate transaction from the swap itself.`;
    case 'sign-in-farcaster':
      return `${req.origin} wants to verify your Farcaster identity using this wallet's address. This only works if this address has already been registered as an auth address for your account through an actual Farcaster client — this wallet can produce a valid signature but can't register itself as one.`;
    default:
      return '';
  }
}

/**
 * Unlock is different from every other approval kind: it needs a password,
 * not just a tap, and on success it must actually call into the key manager
 * — a bare `true` here previously meant "the person tapped approve" without
 * the wallet ever getting unlocked, which was a real bug, not just an
 * unfinished stub.
 */
async function promptUnlock(): Promise<boolean> {
  if (!hasStoredAccount()) {
    return promptCreateAccount();
  }

  return new Promise((resolve) => {
    const p = panel();
    p.appendChild(title('Unlock wallet'));
    const err = subtitle('');
    err.style.color = '#c00';

    const input = document.createElement('input');
    input.type = 'password';
    input.placeholder = 'Password';
    input.autofocus = true;
    Object.assign(input.style, {
      width: '100%',
      padding: '10px',
      marginBottom: '12px',
      boxSizing: 'border-box',
      borderRadius: '8px',
      border: '1px solid #ccc',
      fontSize: '15px',
    } satisfies Partial<CSSStyleDeclaration>);

    const attempt = async () => {
      try {
        await unlockKeyManager(input.value);
        hide();
        resolve(true);
      } catch (e) {
        // Only the key manager's own "Wrong password." should read as that
        // to the user — anything else (a real bug) should say so plainly
        // rather than getting mislabeled as a typo on their end.
        err.textContent = e instanceof Error ? e.message : 'Something went wrong.';
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') attempt();
    });

    p.appendChild(input);
    p.appendChild(err);
    p.appendChild(
      buttonRow(
        attempt,
        () => {
          hide();
          resolve(false);
        },
        'Unlock',
      ),
    );
    show(p);
    input.focus();
  });
}

/**
 * No stored account yet — this is the minimum viable onboarding, not the
 * real one. It creates a 12-word mnemonic, shows it once, and requires the
 * person to type it back before continuing, which is the bar any wallet
 * onboarding needs to clear before it's safe to call done. It does NOT yet
 * do anything nicer than that (no import flow here — see keyManager's
 * importAccount, not wired to any UI yet).
 */
async function promptCreateAccount(): Promise<boolean> {
  return new Promise((resolve) => {
    const p = panel();
    p.appendChild(title('Create a wallet'));
    p.appendChild(subtitle('Choose a password to encrypt your new wallet on this device.'));

    const pw1 = document.createElement('input');
    pw1.type = 'password';
    pw1.placeholder = 'Password';
    const pw2 = document.createElement('input');
    pw2.type = 'password';
    pw2.placeholder = 'Confirm password';
    for (const inp of [pw1, pw2]) {
      Object.assign(inp.style, {
        width: '100%',
        padding: '10px',
        marginBottom: '10px',
        boxSizing: 'border-box',
        borderRadius: '8px',
        border: '1px solid #ccc',
        fontSize: '15px',
      } satisfies Partial<CSSStyleDeclaration>);
      p.appendChild(inp);
    }

    const err = subtitle('');
    err.style.color = '#c00';
    p.appendChild(err);

    const proceed = async () => {
      if (pw1.value.length < 8) {
        err.textContent = 'Password must be at least 8 characters.';
        return;
      }
      if (pw1.value !== pw2.value) {
        err.textContent = "Passwords don't match.";
        return;
      }
      try {
        const { mnemonic } = await createAccount(pw1.value);
        showMnemonic(mnemonic, resolve);
      } catch (e) {
        // Whatever breaks in here (there will be something, eventually)
        // should never again just make the button look unresponsive —
        // that's exactly what happened with the Buffer-in-a-browser bug.
        err.textContent = `Something went wrong: ${e instanceof Error ? e.message : String(e)}`;
      }
    };

    p.appendChild(
      buttonRow(
        proceed,
        () => {
          hide();
          resolve(false);
        },
        'Create',
      ),
    );
    show(p);
  });
}

function showMnemonic(mnemonic: string, resolve: (v: boolean) => void) {
  const p = panel();
  p.appendChild(title('Your recovery phrase'));
  p.appendChild(
    subtitle('Write these 12 words down and keep them somewhere safe. Anyone with this phrase controls this wallet. This is shown once.'),
  );

  const words = document.createElement('div');
  Object.assign(words.style, {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr 1fr',
    gap: '6px',
    marginBottom: '16px',
    fontFamily: 'monospace',
    fontSize: '13px',
  } satisfies Partial<CSSStyleDeclaration>);
  mnemonic.split(' ').forEach((w, i) => {
    const cell = document.createElement('div');
    cell.textContent = `${i + 1}. ${w}`;
    words.appendChild(cell);
  });
  p.appendChild(words);

  const confirmBtn = document.createElement('button');
  confirmBtn.textContent = "I've saved it";
  Object.assign(confirmBtn.style, buttonStyle('#111', '#fff'));
  confirmBtn.onclick = () => {
    hide();
    resolve(true);
  };
  p.appendChild(confirmBtn);
  show(p);
}
