export const HOSTED_SHIORI_PRODUCTION_CONVEX_URL = "https://cautious-puma-129.convex.cloud";

export function resolveHostedShioriConvexUrl(envUrl: string | null | undefined): string {
  const trimmed = envUrl?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : HOSTED_SHIORI_PRODUCTION_CONVEX_URL;
}
