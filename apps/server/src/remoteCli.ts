import type { RemoteExposureMethod, RemoteStatus } from "contracts";
import { connectToRecordedBackend, withCliContext } from "shared/shioriCodeClient";
import type { WsRpcClient } from "shared/wsRpc";

import { findTailscaleCli, setTailscaleOperator } from "./remote/tailscale";
import {
  findInstalledServiceLayout,
  requireServiceAdministrator,
  type ServiceLayout,
} from "./serviceManager";

type RemoteRpc = Pick<WsRpcClient, "remote">;

interface RemoteCliDependencies {
  readonly findService: () => ServiceLayout | null;
  readonly requireAdministrator: (platform: ServiceLayout["platform"]) => unknown;
  readonly connectService: (baseDir: string) => Promise<{
    readonly rpc: RemoteRpc;
    readonly dispose: () => Promise<void>;
  } | null>;
  readonly withLocalRpc: <T>(
    baseDir: string | undefined,
    run: (rpc: RemoteRpc) => Promise<T>,
  ) => Promise<T>;
  readonly findTailscale: () => string | null;
  readonly setOperator: (cli: string | null, account: string) => Promise<void>;
}

const defaultDependencies: RemoteCliDependencies = {
  findService: findInstalledServiceLayout,
  requireAdministrator: requireServiceAdministrator,
  connectService: async (baseDir) => {
    const connection = await connectToRecordedBackend(baseDir);
    return connection
      ? {
          rpc: connection.rpc,
          dispose: () => connection.rpc.dispose(),
        }
      : null;
  },
  withLocalRpc: (baseDir, run) =>
    withCliContext(baseDir === undefined ? {} : { baseDir }, ({ rpc }) => run(rpc)),
  findTailscale: findTailscaleCli,
  setOperator: setTailscaleOperator,
};

interface RemoteCliTarget {
  readonly baseDir: string | undefined;
  readonly service: ServiceLayout | null;
}

function resolveTarget(baseDir: string | undefined, deps: RemoteCliDependencies): RemoteCliTarget {
  const explicitlyTargeted = baseDir !== undefined || Boolean(process.env.SHIORICODE_HOME?.trim());
  if (explicitlyTargeted) {
    return { baseDir, service: null };
  }
  const service = deps.findService();
  return service ? { baseDir: service.stateDir, service } : { baseDir: undefined, service: null };
}

async function withRemoteRpc<T>(
  target: RemoteCliTarget,
  deps: RemoteCliDependencies,
  run: (rpc: RemoteRpc) => Promise<T>,
): Promise<T> {
  if (!target.service) {
    return await deps.withLocalRpc(target.baseDir, run);
  }

  deps.requireAdministrator(target.service.platform);
  const connection = await deps.connectService(target.service.stateDir);
  if (!connection) {
    throw new Error(
      "The ShioriCode service is installed but not reachable. Run `shioricode service start`, then retry.",
    );
  }
  try {
    return await run(connection.rpc);
  } finally {
    await connection.dispose();
  }
}

const METHOD_LABELS: Record<RemoteExposureMethod, string> = {
  off: "Off",
  "shiori-link": "ShioriCode Link",
  "tailscale-serve": "Tailscale Serve",
  "tailscale-funnel": "Tailscale Funnel",
};

export function formatRemoteStatus(status: RemoteStatus): string {
  const tailscaleState = !status.tailscale.installed
    ? "not installed"
    : status.tailscale.running
      ? `connected${status.tailscale.dnsName ? ` (${status.tailscale.dnsName})` : ""}`
      : (status.tailscale.backendState ?? "not connected");
  const lines = [
    `Remote access: ${METHOD_LABELS[status.method]}`,
    `Desired: ${METHOD_LABELS[status.desiredMethod]}`,
    `Reachability: ${status.reachability}`,
    `URL: ${status.url ?? "not available"}`,
    `Sign-in: ${status.authConfigured ? `configured (${status.username ?? "owner"})` : "not configured"}`,
    `Tailscale: ${tailscaleState}`,
  ];
  if (status.notice) lines.push(`Notice: ${status.notice}`);
  return lines.join("\n");
}

export async function remoteStatus(
  baseDir?: string,
  overrides: Partial<RemoteCliDependencies> = {},
): Promise<string> {
  const deps = { ...defaultDependencies, ...overrides };
  const target = resolveTarget(baseDir, deps);
  return await withRemoteRpc(target, deps, async (rpc) =>
    formatRemoteStatus(await rpc.remote.getStatus()),
  );
}

export async function setRemoteExposure(
  method: Extract<RemoteExposureMethod, "off" | "tailscale-serve" | "tailscale-funnel">,
  baseDir?: string,
  overrides: Partial<RemoteCliDependencies> = {},
): Promise<string> {
  const deps = { ...defaultDependencies, ...overrides };
  const target = resolveTarget(baseDir, deps);

  if (target.service?.platform === "linux" && method !== "off") {
    deps.requireAdministrator(target.service.platform);
    await deps.setOperator(deps.findTailscale(), target.service.account);
  }

  return await withRemoteRpc(target, deps, async (rpc) => {
    const status = await rpc.remote.setExposure({ method });
    return formatRemoteStatus(status);
  });
}
