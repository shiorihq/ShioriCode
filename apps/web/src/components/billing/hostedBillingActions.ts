import type { HostedBillingCheckoutInput, HostedBillingPortalFlow, NativeApi } from "contracts";

type HostedBillingApi = Pick<NativeApi, "server" | "shell">;

export async function openHostedBillingCheckout(
  api: HostedBillingApi,
  input: HostedBillingCheckoutInput,
): Promise<void> {
  const result = await api.server.createHostedBillingCheckout(input);
  await api.shell.openExternal(result.url);
}

export async function openHostedBillingPortal(
  api: HostedBillingApi,
  flow: HostedBillingPortalFlow,
): Promise<void> {
  const result = await api.server.createHostedBillingPortal(flow);
  await api.shell.openExternal(result.url);
}
