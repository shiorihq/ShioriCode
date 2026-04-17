import { Box, Text } from "ink";
import React, { useEffect, useState } from "react";
import type { ProviderInteractionMode, RuntimeMode, ServerProvider } from "contracts";
import type { Thread } from "shared/orchestrationClientTypes";

import { palette } from "../theme";

function sessionBadge(thread: Thread): string {
  return thread.session?.orchestrationStatus ?? "idle";
}

function formatRelative(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diff = Math.max(0, now - then);
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function threadPreview(thread: Thread, maxChars: number): string {
  const lastMessage = thread.messages[thread.messages.length - 1];
  const source = lastMessage?.text ?? "";
  const collapsed = source.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, Math.max(1, maxChars - 1))}…`;
}

export function Panel({
  title,
  accent,
  children,
  footer,
}: {
  readonly title: string;
  readonly accent?: string;
  readonly children: React.ReactNode;
  readonly footer?: React.ReactNode;
}) {
  const color = accent ?? palette.accent;
  return (
    <Box
      borderStyle="round"
      borderColor={color}
      flexDirection="column"
      paddingX={1}
      paddingY={0}
      marginX={1}
    >
      <Text color={color} bold>
        {title}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {children}
      </Box>
      {footer ? (
        <Box marginTop={1}>
          <Text dimColor>{footer}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

export function ThreadPicker({
  threads,
  selectedIndex,
}: {
  readonly threads: ReadonlyArray<Thread>;
  readonly selectedIndex: number;
}) {
  const now = useNow();
  return (
    <Panel title="threads" footer="↑↓ navigate · enter switch · esc close">
      {threads.length === 0 ? (
        <Text dimColor>No active threads</Text>
      ) : (
        threads.map((thread, index) => {
          const selected = index === selectedIndex;
          const running = thread.session?.orchestrationStatus === "running";
          const statusColor = running ? palette.running : palette.success;
          const preview = threadPreview(thread, 60);
          const relative = formatRelative(thread.updatedAt ?? thread.createdAt, now);
          return (
            <Box key={thread.id} flexDirection="column">
              <Box>
                <Text {...(selected ? { color: palette.accent } : {})}>
                  {selected ? "›" : " "}{" "}
                </Text>
                <Text bold={selected} {...(selected ? { color: palette.accentBright } : {})}>
                  {thread.title}
                </Text>
                <Text color={statusColor} dimColor={!selected}>
                  {" "}
                  [{sessionBadge(thread)}]
                </Text>
                {relative ? <Text dimColor>{"  " + relative}</Text> : null}
              </Box>
              {preview ? (
                <Box>
                  <Text dimColor>{"    " + preview}</Text>
                </Box>
              ) : null}
            </Box>
          );
        })
      )}
    </Panel>
  );
}

export interface SettingsOverlayProps {
  readonly provider: string;
  readonly model: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly providerSnapshot: ServerProvider | null;
  readonly isShiori: boolean;
  readonly isExternalLoginProvider: boolean;
}

export function SettingsOverlay({
  provider,
  model,
  runtimeMode,
  interactionMode,
  providerSnapshot,
  isShiori,
  isExternalLoginProvider,
}: SettingsOverlayProps) {
  const statusColor = providerSnapshot ? statusToneColor(providerSnapshot.status) : undefined;

  return (
    <Panel title="settings" footer="esc close · f refresh providers">
      <SettingsRow label="provider" value={provider} hint="[ ]" />
      <SettingsRow label="model" value={model} hint="← →" />
      <SettingsRow
        label="runtime"
        value={runtimeMode === "full-access" ? "full access" : "approval required"}
        hint="r"
      />
      <SettingsRow label="mode" value={interactionMode === "plan" ? "plan" : "default"} hint="i" />
      {providerSnapshot ? (
        <>
          {statusColor ? (
            <SettingsRow label="status" value={providerSnapshot.status} valueColor={statusColor} />
          ) : (
            <SettingsRow label="status" value={providerSnapshot.status} />
          )}
          <SettingsRow
            label="auth"
            value={providerSnapshot.auth.label ?? providerSnapshot.auth.status}
            {...(isExternalLoginProvider ? { hint: "l login" } : {})}
          />
          {providerSnapshot.message ? (
            <Text dimColor italic>
              {providerSnapshot.message}
            </Text>
          ) : null}
        </>
      ) : null}
      {isShiori ? (
        <Box marginTop={1}>
          <Text dimColor>e edit api url · t import token · x clear token</Text>
        </Box>
      ) : null}
    </Panel>
  );
}

function SettingsRow({
  label,
  value,
  valueColor,
  hint,
}: {
  readonly label: string;
  readonly value: string;
  readonly valueColor?: string;
  readonly hint?: string;
}) {
  return (
    <Box>
      <Box width={10}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box flexGrow={1}>
        <Text bold {...(valueColor ? { color: valueColor } : {})}>
          {value}
        </Text>
      </Box>
      {hint ? <Text dimColor>{hint}</Text> : null}
    </Box>
  );
}

function statusToneColor(status: string): string | undefined {
  switch (status) {
    case "ready":
      return palette.success;
    case "warning":
      return palette.warning;
    case "error":
      return palette.danger;
    default:
      return undefined;
  }
}

export function PromptOverlay({
  title,
  placeholder,
  value,
  secret,
}: {
  readonly title: string;
  readonly placeholder?: string;
  readonly value: string;
  readonly secret?: boolean;
}) {
  return (
    <Panel title={title} accent={palette.accent} footer="enter submit · esc cancel">
      {placeholder ? <Text dimColor>{placeholder}</Text> : null}
      <Text>
        <Text color={palette.accent}>{"› "}</Text>
        {secret ? "•".repeat(value.length) : value || " "}
      </Text>
    </Panel>
  );
}

export function ApprovalBanner({
  title,
  detail,
}: {
  readonly title: string;
  readonly detail?: string;
}) {
  return (
    <Panel title={title} accent="yellow" footer="1 accept · 2 allow session · 3 decline · 4 cancel">
      {detail ? <Text>{detail}</Text> : null}
    </Panel>
  );
}

export function UserInputBanner({
  header,
  question,
  options,
}: {
  readonly header: string;
  readonly question: string;
  readonly options: ReadonlyArray<{ label: string; description: string }>;
}) {
  return (
    <Panel title={header} accent={palette.accent} footer="press 1–9 to answer">
      <Text>{question}</Text>
      {options.map((option, index) => (
        <Box key={option.label}>
          <Text color={palette.accent}>{index + 1}. </Text>
          <Text>{option.label} </Text>
          <Text dimColor>— {option.description}</Text>
        </Box>
      ))}
    </Panel>
  );
}

export function ErrorBanner({ message }: { readonly message: string }) {
  return (
    <Panel title="error" accent={palette.danger} footer="resolves when the next action succeeds">
      <Text color={palette.danger}>{message}</Text>
    </Panel>
  );
}
