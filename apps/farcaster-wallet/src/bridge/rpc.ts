// Minimal JSON-RPC 2.0 over MessagePort, matching the wire envelope used by
// apps/farcaster-web's EmbeddedWallet.tsx and packages/farcaster-client-data's
// messageChannelRpc module: { [channelName]: { id, jsonrpc, method, params } }
// for requests, and { [channelName]: { id, jsonrpc, result | error } } for
// responses. Verified against upstream source directly rather than assumed.
//
// This is a deliberately dependency-free reimplementation (no 'ox') so the
// wallet bundle stays small and auditable — the whole point of an origin
// that holds private keys.

export type RpcRequestMsg = {
  id: number;
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
};

export type RpcResponseMsg =
  | { id: number; jsonrpc: '2.0'; result: unknown }
  | { id: number; jsonrpc: '2.0'; error: { code: number; message: string } };

export class RpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

// Standard EIP-1193 / JSON-RPC error codes we actually use.
export const ERR_USER_REJECTED = 4001;
export const ERR_METHOD_NOT_FOUND = -32601;
export const ERR_INTERNAL = -32603;
export const ERR_INVALID_PARAMS = -32602;

let nextId = 1;

/**
 * Client role: sends requests out over a named channel on a port and
 * resolves/rejects on the matching response. Used by the wallet to call
 * INTO the parent (e.g. 'warpcast' channel: open_wallet, send_token_result).
 */
export function createRpcClient(channelName: string, port: MessagePort) {
  const pending = new Map<number, (msg: RpcResponseMsg) => void>();

  function onMessage(event: MessageEvent<Record<string, RpcResponseMsg>>) {
    const msg = event.data?.[channelName];
    if (!msg) return;
    const cb = pending.get(msg.id);
    if (!cb) return;
    pending.delete(msg.id);
    cb(msg);
  }
  port.addEventListener('message', onMessage);

  async function request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, (msg) => {
        if ('error' in msg) reject(new RpcError(msg.error.code, msg.error.message));
        else resolve(msg.result as T);
      });
      port.postMessage({ [channelName]: { id, jsonrpc: '2.0', method, params } });
    });
  }

  function destroy() {
    port.removeEventListener('message', onMessage);
    for (const cb of pending.values()) {
      cb({ id: -1, jsonrpc: '2.0', error: { code: ERR_INTERNAL, message: 'Client destroyed' } });
    }
    pending.clear();
  }

  return { request, destroy };
}

/**
 * Server role: listens for requests on a named channel and dispatches to a
 * handler, replying with the same envelope shape. Used by the wallet for
 * 'init', 'ethProvider', and 'solanaProvider' — the three channels where the
 * wallet is the RPC server, per the schema read out of the parent's source.
 */
export function createRpcServer(
  channelName: string,
  port: MessagePort,
  handler: (method: string, params: unknown) => Promise<unknown>,
) {
  async function onMessage(event: MessageEvent<Record<string, RpcRequestMsg>>) {
    const req = event.data?.[channelName];
    if (!req) return;
    try {
      const result = await handler(req.method, req.params);
      port.postMessage({ [channelName]: { id: req.id, jsonrpc: '2.0', result } });
    } catch (e) {
      const err =
        e instanceof RpcError
          ? { code: e.code, message: e.message }
          : { code: ERR_INTERNAL, message: e instanceof Error ? e.message : String(e) };
      port.postMessage({ [channelName]: { id: req.id, jsonrpc: '2.0', error: err } });
    }
  }
  port.addEventListener('message', onMessage);
  return { close: () => port.removeEventListener('message', onMessage) };
}
