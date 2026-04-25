import { Box, Text } from "ink";
import React, { useEffect, useState } from "react";
import type { ProviderInteractionMode, ProviderKind, RuntimeMode } from "contracts";

import type { EditorMode, VimMode } from "./Composer";
import { palette } from "../theme";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

function useSpinner(active: boolean) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) {
      return;
    }
    const id = setInterval(() => setFrame((current) => (current + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(id);
  }, [active]);
  return SPINNER_FRAMES[frame];
}

function useElapsed(startIso: string | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startIso) {
      return;
    }
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [startIso]);
  if (!startIso) {
    return null;
  }
  const elapsed = Math.max(0, now - new Date(startIso).getTime());
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

function providerLabel(provider: ProviderKind | null): string {
  switch (provider) {
    case "shiori":
      return "shiori";
    case "kimiCode":
      return "kimi";
    case "gemini":
      return "gemini";
    case "cursor":
      return "cursor";
    case "claudeAgent":
      return "claude";
    case "codex":
      return "codex";
    default:
      return "—";
  }
}

function runtimeLabel(mode: RuntimeMode): string {
  return mode === "full-access" ? "full" : "ask";
}

function interactionLabel(mode: ProviderInteractionMode): string {
  return mode === "plan" ? "plan" : "default";
}

export interface StatusLineProps {
  readonly provider: ProviderKind | null;
  readonly model: string | null;
  readonly runtimeMode: RuntimeMode | null;
  readonly interactionMode: ProviderInteractionMode | null;
  readonly sessionStatus: string;
  readonly activeSince: string | null;
  readonly notice: string | null;
  readonly error: string | null;
  readonly editorMode: EditorMode;
  readonly vimMode: VimMode;
  readonly hint: string;
}

export function StatusLine({
  provider,
  model,
  runtimeMode,
  interactionMode,
  sessionStatus,
  activeSince,
  notice,
  error,
  editorMode,
  vimMode,
  hint,
}: StatusLineProps) {
  const active = activeSince !== null;
  const spinner = useSpinner(active);
  const elapsed = useElapsed(activeSince);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color={palette.accent}>{providerLabel(provider)}</Text>
        {model ? (
          <>
            <Text dimColor> · </Text>
            <Text>{model}</Text>
          </>
        ) : null}
        {runtimeMode ? (
          <>
            <Text dimColor> · </Text>
            <Text dimColor>{runtimeLabel(runtimeMode)}</Text>
          </>
        ) : null}
        {interactionMode && interactionMode !== "default" ? (
          <>
            <Text dimColor> · </Text>
            <Text color={palette.warning}>{interactionLabel(interactionMode)}</Text>
          </>
        ) : null}
        {editorMode === "vim" ? (
          <>
            <Text dimColor> · </Text>
            <Text color={palette.accentBright}>vim</Text>
          </>
        ) : null}
        <Text> </Text>
        {active ? (
          <Text color={palette.running}>
            {spinner} {sessionStatus}
            {elapsed ? ` · ${elapsed}` : ""}
          </Text>
        ) : (
          <Text color={palette.success}>● {sessionStatus}</Text>
        )}
      </Box>
      <Box>
        {editorMode === "vim" && vimMode === "INSERT" ? (
          <>
            <Text dimColor>-- INSERT --</Text>
            <Text dimColor> · </Text>
          </>
        ) : null}
        <Text dimColor>{hint}</Text>
      </Box>
      {notice ? <Text color={palette.success}>{notice}</Text> : null}
      {error ? <Text color={palette.danger}>{error}</Text> : null}
    </Box>
  );
}
