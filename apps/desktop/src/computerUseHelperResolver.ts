import { existsSync } from "node:fs";

import { computerUseHelperCandidatesFor, processResourcesPath } from "shared/computerUseHelper";

const COMPUTER_USE_HELPER_BINARY_ENV = "SHIORICODE_COMPUTER_USE_HELPER_BINARY";

export interface ComputerUseHelperResolveInput {
  readonly platform: NodeJS.Platform;
  readonly rootDir: string;
  readonly configured?: string | null;
  readonly resourcesPath?: string | null;
  readonly packagePath?: string | null;
  readonly exists?: (filePath: string) => boolean;
}

export function isAsarPath(filePath: string): boolean {
  return filePath
    .split(/[\\/]/)
    .some((segment) => segment === "app.asar" || segment.endsWith(".asar"));
}

export function resolveComputerUseHelperPathFor(
  input: ComputerUseHelperResolveInput,
): string | null {
  if (input.platform !== "darwin") {
    return null;
  }

  const exists = input.exists ?? existsSync;
  const candidates = computerUseHelperCandidatesFor({
    appRoot: input.rootDir,
    ...(input.configured !== undefined ? { configured: input.configured } : {}),
    ...(input.packagePath !== undefined ? { packagePath: input.packagePath } : {}),
    ...(input.resourcesPath !== undefined ? { resourcesPath: input.resourcesPath } : {}),
    buildConfigurationOrder: ["release", "debug"],
  });

  return candidates.find((candidate) => !isAsarPath(candidate) && exists(candidate)) ?? null;
}

export function resolveComputerUseHelperPath(rootDir: string): string | null {
  const configured = process.env[COMPUTER_USE_HELPER_BINARY_ENV];
  const resourcesPath = processResourcesPath();
  return resolveComputerUseHelperPathFor({
    platform: process.platform,
    rootDir,
    ...(configured !== undefined ? { configured } : {}),
    ...(resourcesPath !== null ? { resourcesPath } : {}),
  });
}
