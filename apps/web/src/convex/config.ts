import { HOSTED_SHIORI_PRODUCTION_CONVEX_URL } from "shared/hostedShioriConvex";

const DEVELOPMENT_CONVEX_URL =
  import.meta.env.VITE_CONVEX_URL?.trim() || "https://modest-guanaco-471.convex.cloud";

export const convexDeploymentUrl = import.meta.env.PROD
  ? HOSTED_SHIORI_PRODUCTION_CONVEX_URL
  : DEVELOPMENT_CONVEX_URL;

export function convexStorageNamespace(url: string): string {
  return url.replace(/[^a-zA-Z0-9]/g, "");
}

export function convexStorageKey(baseKey: string, url: string): string {
  return `${baseKey}_${convexStorageNamespace(url)}`;
}
