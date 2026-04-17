import { Box, Text } from "ink";
import React from "react";
import type { ProviderInteractionMode, RuntimeMode, ServerProvider } from "contracts";
import type { Thread } from "shared/orchestrationClientTypes";

import { palette } from "../theme";

function sessionBadge(thread: Thread): string {
  return thread.session?.orchestrationStatus ?? "idle";
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
  return (
    <Panel title="threads" footer="↑↓ navigate · enter switch · esc close">
      {threads.length === 0 ? (
        <Text dimColor>No active threads</Text>
      ) : (
        threads.map((thread, index) => {
          const selected = index === selectedIndex;
          const running = thread.session?.orchestrationStatus === "running";
          const statusColor = running ? palette.running : palette.success;
          return (
            <Box key={thread.id}>
              <Text {...(selected ? { color: palette.accent } : {})}>{selected ? "›" : " "} </Text>
              <Text bold={selected} {...(selected ? { color: palette.accentBright } : {})}>
                {thread.title}
              </Text>
              <Text color={statusColor} dimColor={!selected}>
                {" "}
                [{sessionBadge(thread)}]
              </Text>
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
    <Panel
      title="settings"
      footer="esc close · [ ] provider · ← → model · r runtime · i interaction · f refresh"
    >
      <SettingsRow label="provider" value={provider} />
      <SettingsRow label="model" value={model} />
      <SettingsRow
        label="runtime"
        value={runtimeMode === "full-access" ? "full access" : "approval required"}
      />
      <SettingsRow label="mode" value={interactionMode === "plan" ? "plan" : "default"} />
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
      ) : isExternalLoginProvider ? (
        <Box marginTop={1}>
          <Text dimColor>l login</Text>
        </Box>
      ) : null}
    </Panel>
  );
}

function SettingsRow({
  label,
  value,
  valueColor,
}: {
  readonly label: string;
  readonly value: string;
  readonly valueColor?: string;
}) {
  return (
    <Box>
      <Box width={10}>
        <Text dimColor>{label}</Text>
      </Box>
      <Text bold {...(valueColor ? { color: valueColor } : {})}>
        {value}
      </Text>
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
