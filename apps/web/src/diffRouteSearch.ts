import { TurnId } from "contracts";

import { normalizeThreadPaneSearchParam } from "./paneLayout/threadPanes";

export interface DiffRouteSearch {
  diff?: "1" | undefined;
  diffTurnId?: TurnId | undefined;
  diffFilePath?: string | undefined;
  artifact?: "1" | undefined;
  artifactPath?: string | undefined;
  browser?: "1" | undefined;
  panel?: RightPanelId | undefined;
  panes?: string | undefined;
}

export type RightPanelId = "diff" | "artifact" | "browser";

function isPanelOpenValue(value: unknown): boolean {
  return value === "1" || value === 1 || value === true;
}

function normalizeSearchString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeRightPanelId(value: unknown): RightPanelId | undefined {
  if (value !== "diff" && value !== "artifact" && value !== "browser") {
    return undefined;
  }
  return value;
}

export function stripDiffSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "diff" | "diffTurnId" | "diffFilePath"> {
  const { diff: _diff, diffTurnId: _diffTurnId, diffFilePath: _diffFilePath, ...rest } = params;
  return rest as Omit<T, "diff" | "diffTurnId" | "diffFilePath">;
}

export function stripArtifactSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "artifact" | "artifactPath"> {
  const { artifact: _artifact, artifactPath: _artifactPath, ...rest } = params;
  return rest as Omit<T, "artifact" | "artifactPath">;
}

export function stripBrowserSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "browser"> {
  const { browser: _browser, ...rest } = params;
  return rest as Omit<T, "browser">;
}

export function stripRightPanelSearchParam<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "panel"> {
  const { panel: _panel, ...rest } = params;
  return rest as Omit<T, "panel">;
}

export function stripRightSidebarSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<
  T,
  "artifact" | "artifactPath" | "browser" | "diff" | "diffFilePath" | "diffTurnId" | "panel"
> &
  Partial<
    Record<
      "artifact" | "artifactPath" | "browser" | "diff" | "diffFilePath" | "diffTurnId" | "panel",
      undefined
    >
  > {
  const {
    artifact: _artifact,
    artifactPath: _artifactPath,
    browser: _browser,
    diff: _diff,
    diffFilePath: _diffFilePath,
    diffTurnId: _diffTurnId,
    panel: _panel,
    ...rest
  } = params;
  return {
    ...rest,
    artifact: undefined,
    artifactPath: undefined,
    browser: undefined,
    diff: undefined,
    diffFilePath: undefined,
    diffTurnId: undefined,
    panel: undefined,
  } as Omit<
    T,
    "artifact" | "artifactPath" | "browser" | "diff" | "diffFilePath" | "diffTurnId" | "panel"
  > &
    Partial<
      Record<
        "artifact" | "artifactPath" | "browser" | "diff" | "diffFilePath" | "diffTurnId" | "panel",
        undefined
      >
    >;
}

export function resolveActiveThreadPanel(
  search: Pick<DiffRouteSearch, "artifact" | "browser" | "diff" | "panel">,
  options: { browserEnabled?: boolean } = {},
): RightPanelId | null {
  const diffOpen = search.diff === "1";
  const artifactOpen = search.artifact === "1";
  const browserOpen = search.browser === "1" && options.browserEnabled !== false;
  const requestedPanel = search.panel;

  if (requestedPanel === "diff" && diffOpen) {
    return "diff";
  }
  if (requestedPanel === "artifact" && artifactOpen) {
    return "artifact";
  }
  if (requestedPanel === "browser" && browserOpen) {
    return "browser";
  }

  if (browserOpen) {
    return "browser";
  }
  if (artifactOpen) {
    return "artifact";
  }
  return diffOpen ? "diff" : null;
}

export function parseDiffRouteSearch(search: Record<string, unknown>): DiffRouteSearch {
  const diff = isPanelOpenValue(search.diff) ? "1" : undefined;
  const diffTurnIdRaw = diff ? normalizeSearchString(search.diffTurnId) : undefined;
  const diffTurnId = diffTurnIdRaw ? TurnId.makeUnsafe(diffTurnIdRaw) : undefined;
  const diffFilePath = diff && diffTurnId ? normalizeSearchString(search.diffFilePath) : undefined;
  const artifact = isPanelOpenValue(search.artifact) ? "1" : undefined;
  const artifactPath = artifact ? normalizeSearchString(search.artifactPath) : undefined;
  const browser = isPanelOpenValue(search.browser) ? "1" : undefined;
  const rawPanel = normalizeRightPanelId(search.panel);
  const panel =
    rawPanel === "diff" && diff
      ? rawPanel
      : rawPanel === "artifact" && artifact && artifactPath
        ? rawPanel
        : rawPanel === "browser" && browser
          ? rawPanel
          : undefined;
  const panes = normalizeThreadPaneSearchParam(search.panes);

  return {
    ...(diff ? { diff } : {}),
    ...(diffTurnId ? { diffTurnId } : {}),
    ...(diffFilePath ? { diffFilePath } : {}),
    ...(artifact && artifactPath ? { artifact, artifactPath } : {}),
    ...(browser ? { browser } : {}),
    ...(panel ? { panel } : {}),
    ...(panes ? { panes } : {}),
  };
}
