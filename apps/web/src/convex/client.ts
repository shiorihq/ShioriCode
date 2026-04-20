import { ConvexReactClient } from "convex/react";
import { convexDeploymentUrl } from "./config";

export const convex = new ConvexReactClient(convexDeploymentUrl);
