import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ComputerUsePermissionSubject } from "contracts";

const HELPER_BINARY_NAME = "ShioriComputerUseHelper";

export type ComputerUseHelperBuildConfiguration = "debug" | "release";

export interface ComputerUseHelperCandidateInput {
  readonly appRoot: string;
  readonly configured?: string | null;
  readonly packagePath?: string | null;
  readonly resourcesPath?: string | null;
  readonly buildConfigurationOrder?: ReadonlyArray<ComputerUseHelperBuildConfiguration>;
}

export function resolveAppRootFromModule(moduleUrl: string, appName = "server"): string {
  const modulePath = fileURLToPath(moduleUrl);
  const marker = `${path.sep}apps${path.sep}${appName}${path.sep}`;
  const markerIndex = modulePath.lastIndexOf(marker);
  return markerIndex >= 0 ? modulePath.slice(0, markerIndex) : process.cwd();
}

export function processResourcesPath(): string | null {
  const maybeElectronProcess = process as NodeJS.Process & { readonly resourcesPath?: unknown };
  return typeof maybeElectronProcess.resourcesPath === "string"
    ? maybeElectronProcess.resourcesPath
    : null;
}

export function computerUseHelperCandidatesFor(input: ComputerUseHelperCandidateInput): string[] {
  const configured = input.configured?.trim();
  const packagePath =
    input.packagePath?.trim() || path.join(input.appRoot, "apps/desktop/native/ShioriComputerUse");
  const resourcesPath = input.resourcesPath?.trim();
  const buildConfigurationOrder = input.buildConfigurationOrder ?? ["debug", "release"];
  return [
    configured,
    ...buildConfigurationOrder.map((configuration) =>
      path.join(packagePath, ".build", configuration, HELPER_BINARY_NAME),
    ),
    path.join(input.appRoot, "apps/desktop/resources/native/macos", HELPER_BINARY_NAME),
    path.join(input.appRoot, "apps/desktop/prod-resources/native/macos", HELPER_BINARY_NAME),
    ...(resourcesPath
      ? [
          path.join(resourcesPath, "native", "macos", HELPER_BINARY_NAME),
          path.join(resourcesPath, "resources", "native", "macos", HELPER_BINARY_NAME),
        ]
      : []),
  ].flatMap((candidate) => (candidate ? [candidate] : []));
}

export function computerUsePermissionSubjectForHelperPath(
  helperPath: string | null | undefined,
): ComputerUsePermissionSubject {
  const normalizedPath =
    typeof helperPath === "string" && helperPath.trim() ? helperPath.trim() : null;
  return {
    kind: "helper",
    displayName: normalizedPath ? path.basename(normalizedPath) : "ShioriCode Computer Use helper",
    path: normalizedPath,
  };
}
