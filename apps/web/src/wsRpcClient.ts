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

export function createWsRpcClient(transport = new WsTransport()): WsRpcClient {
  return createSharedWsRpcClient({
    transport,
    url: resolveServerUrl({
      protocol: window.location.protocol === "https:" ? "wss" : "ws",
      pathname: "/ws",
    }),
  });
}

export type { WsRpcClient };
