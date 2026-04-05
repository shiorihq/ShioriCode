import { ConvexReactClient } from "convex/react";

const deploymentUrl = import.meta.env.VITE_CONVEX_URL;

if (!deploymentUrl) {
  throw new Error(
    "Missing VITE_CONVEX_URL. Configure apps/web/.env.local before starting ShioriCode.",
  );
}

export const convex = new ConvexReactClient(deploymentUrl);
