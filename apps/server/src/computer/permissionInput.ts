function envString(environment: Record<string, string | undefined>, name: string): string | null {
  const value = environment[name]?.trim();
  return value && value.length > 0 ? value : null;
}

function inputString(input: Record<string, unknown>, name: string): string | null {
  const value = input[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function enrichComputerPermissionGuideInput(
  input: Record<string, unknown>,
  environment: Record<string, string | undefined> = process.env,
): Record<string, unknown> {
  const hostAppBundlePath =
    inputString(input, "hostAppBundlePath") ??
    envString(environment, "SHIORICODE_COMPUTER_USE_HOST_APP_BUNDLE_PATH");
  const hostAppDisplayName =
    inputString(input, "hostAppDisplayName") ??
    envString(environment, "SHIORICODE_COMPUTER_USE_HOST_APP_DISPLAY_NAME");
  return {
    ...input,
    ...(hostAppBundlePath ? { hostAppBundlePath } : {}),
    ...(hostAppDisplayName ? { hostAppDisplayName } : {}),
  };
}
