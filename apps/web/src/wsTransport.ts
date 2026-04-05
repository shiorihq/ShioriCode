import { WsTransport as SharedWsTransport } from "shared/wsRpc";

import { resolveServerUrl } from "./lib/utils";

export class WsTransport extends SharedWsTransport {
  constructor(url?: string) {
    super(
      resolveServerUrl({
        url,
        protocol: window.location.protocol === "https:" ? "wss" : "ws",
        pathname: "/ws",
      }),
    );
  }
}
