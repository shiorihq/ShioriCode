const FEATURE_FLAG_ENV_PREFIXES = [
  "SHIORICODE_FEATURE_FLAG_",
  "VITE_SHIORICODE_FEATURE_FLAG_",
] as const;

const TRUE_VALUES = new Set(["1", "true", "yes", "on", "enabled"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off", "disabled"]);

export type FeatureFlagEnvironment = Record<string, unknown>;

function featureFlagEnvSuffix(key: string): string {
  return key
    .trim()
    .replace(/[^a-zA-Z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toUpperCase();
}

export function hostedShioriFeatureFlagEnvNames(key: string): readonly string[] {
  const suffix = featureFlagEnvSuffix(key);
  if (!suffix) {
    return [];
  }
  return FEATURE_FLAG_ENV_PREFIXES.map((prefix) => `${prefix}${suffix}`);
}

export function parseHostedShioriFeatureFlagOverride(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) {
    return true;
  }
  if (FALSE_VALUES.has(normalized)) {
    return false;
  }
  return undefined;
}

export function readHostedShioriFeatureFlagOverride(
  key: string,
  env: FeatureFlagEnvironment,
): boolean | undefined {
  for (const envName of hostedShioriFeatureFlagEnvNames(key)) {
    const override = parseHostedShioriFeatureFlagOverride(env[envName]);
    if (override !== undefined) {
      return override;
    }
  }
  return undefined;
}
