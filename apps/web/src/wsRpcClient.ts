import { type WsRpcClient, createWsRpcClient as createSharedWsRpcClient } from "shared/wsRpc";

import { resolveServerUrl } from "./lib/utils";
import { WsTransport } from "./wsTransport";

let sharedWsRpcClient: WsRpcClient | null = null;

export function getWsRpcClient(): WsRpcClient {
  if (sharedWsRpcClient) {
    return sharedWsRpcClient;
  }
  sharedWsRpcClient = createWsRpcClient();
  return sharedWsRpcClient;
}

export async function __resetWsRpcClientForTests() {
  await sharedWsRpcClient?.dispose();
  sharedWsRpcClient = null;
}

export function createWsRpcClient(transport?: WsTransport): WsRpcClient {
  const url = resolveServerUrl({
    protocol: window.location.protocol === "https:" ? "wss" : "ws",
    pathname: "/ws",
  });

  return createSharedWsRpcClient({
    transport: transport ?? new WsTransport(url),
    url,
  });
}

export type { WsRpcClient };
