import { useCallback, useEffect, useRef, useState } from "react";
import { LazyMotion, domAnimation, m, useReducedMotion } from "framer-motion";
import { IconCheckOutline24 as CheckIcon } from "nucleo-core-outline-24";
import { PROVIDER_DISPLAY_NAMES, type ProviderKind, type ServerProvider } from "contracts";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useSettings } from "../../hooks/useSettings";
import { getPersonalDetailsBlurClass } from "../../lib/personalDetails";
import { Button } from "../ui/button";
import { cn } from "~/lib/utils";

const EASE = [0.4, 0, 0.2, 1] as const;

const STATUS_DOT_STYLES: Record<ServerProvider["status"], string> = {
  ready: "bg-success",
  warning: "bg-warning",
  error: "bg-destructive",
  disabled: "bg-muted-foreground/40",
};

const PROVIDER_DESCRIPTIONS: Record<ProviderKind, string> = {
  shiori: "Shiori hosted API",
  kimiCode: "Kimi Code CLI",
  gemini: "Google Gemini CLI",
  cursor: "Cursor CLI",
  codex: "OpenAI Codex CLI",
  claudeAgent: "Anthropic Claude Code CLI",
};

const PROVIDER_INSTALL_INSTRUCTIONS: Partial<Record<ProviderKind, readonly string[]>> = {
  kimiCode: ["curl -LsSf https://code.kimi.com/install.sh | bash", "kimi login"],
  gemini: ["npm install -g @google/gemini-cli", "gemini"],
  cursor: ["curl https://cursor.com/install -fsS | bash", "cursor-agent login"],
  codex: ["npm install -g @openai/codex", "codex login"],
  claudeAgent: ["npm install -g @anthropic-ai/claude-code", "claude auth login"],
};

type ProviderCardProps = {
  provider: ServerProvider;
  index: number;
  viewerEmail?: string | null | undefined;
  onRefresh: () => void;
  isRefreshing: boolean;
};

export function ProviderCard({
  provider,
  index,
  viewerEmail,
  onRefresh,
  isRefreshing,
}: ProviderCardProps) {
  const blurPersonalData = useSettings().blurPersonalData;
  const shouldReduceMotion = useReducedMotion();
  const skip = !!shouldReduceMotion;
  const isReady = provider.status === "ready";
  const wasReadyRef = useRef(isReady);
  const [justConnected, setJustConnected] = useState(false);

  useEffect(() => {
    if (isReady && !wasReadyRef.current) {
      setJustConnected(true);
      const timer = setTimeout(() => setJustConnected(false), 600);
      return () => clearTimeout(timer);
    }
    wasReadyRef.current = isReady;
  }, [isReady]);

  const handleRefresh = useCallback(() => {
    onRefresh();
  }, [onRefresh]);

  const kind = provider.provider;
  const displayName = PROVIDER_DISPLAY_NAMES[kind];
  const description = PROVIDER_DESCRIPTIONS[kind];
  const instructions = PROVIDER_INSTALL_INSTRUCTIONS[kind];
  const installCommandBlock = instructions?.join("\n") ?? "";
  const { copyToClipboard } = useCopyToClipboard<void>();

  const statusLabel = isReady
    ? "Connected"
    : !provider.installed
      ? "Not installed"
      : provider.auth.status === "unauthenticated"
        ? "Sign in required"
        : "Checking";

  const showInstructions = !isReady && instructions;
  const showShioriDetail = kind === "shiori" && isReady && viewerEmail;

  return (
    <LazyMotion features={domAnimation}>
      <m.div
        initial={skip ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: index * 0.05, ease: EASE }}
        className={cn(
          "rounded-xl border border-border/70 bg-background/40 p-4 transition-colors",
          "hover:border-foreground/15 hover:bg-background/70",
          justConnected && "provider-card-connected",
        )}
      >
        {/* Header row */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <div
              className={cn(
                "size-2 shrink-0 rounded-full transition-colors duration-300",
                STATUS_DOT_STYLES[provider.status],
              )}
            />
            <span className="text-sm font-medium text-foreground">{displayName}</span>
            {provider.version ? (
              <span className="font-mono text-[11px] text-muted-foreground/60">
                v{provider.version}
              </span>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <span
              className={cn(
                "text-xs",
                isReady ? "text-success-foreground" : "text-muted-foreground",
              )}
            >
              {statusLabel}
            </span>
            {isReady ? <CheckIcon className="size-3.5 text-success-foreground" /> : null}
          </div>
        </div>

        {/* Description */}
        <p className="mt-1.5 pl-[18px] text-xs text-muted-foreground/60">
          {showShioriDetail ? (
            <>
              Authenticated as{" "}
              <span className={getPersonalDetailsBlurClass(blurPersonalData)}>{viewerEmail}</span>
            </>
          ) : (
            description
          )}
        </p>

        {/* Install instructions for CLI providers */}
        {showInstructions ? (
          <div className="mt-3 space-y-2 pl-[18px]">
            <p className="text-xs text-muted-foreground/70">Install the CLI, then authenticate:</p>
            <div className="rounded-lg border border-border/50 bg-muted/30 px-3 py-2.5 font-mono text-[12px] leading-[1.7] text-foreground/65 select-text">
              {instructions.map((cmd) => (
                <div key={cmd}>
                  <span className="text-muted-foreground/40">$ </span>
                  {cmd}
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="xs"
                variant="outline"
                onClick={() => void copyToClipboard(installCommandBlock, undefined)}
              >
                Copy commands
              </Button>
              <Button size="xs" variant="outline" onClick={handleRefresh} disabled={isRefreshing}>
                {isRefreshing ? "Checking..." : "Check again"}
              </Button>
            </div>
          </div>
        ) : null}

        {/* Not-ready Shiori (edge case) */}
        {kind === "shiori" && !isReady ? (
          <div className="mt-2 pl-[18px]">
            <Button size="xs" variant="outline" onClick={handleRefresh} disabled={isRefreshing}>
              {isRefreshing ? "Checking..." : "Check again"}
            </Button>
          </div>
        ) : null}
      </m.div>
    </LazyMotion>
  );
}
