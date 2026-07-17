import qrcode from "qrcode-generator";
import {
  IconCircleCheckOutline24 as CheckCircle2Icon,
  IconClockOutline24 as ClockIcon,
  IconCopyOutline24 as CopyIcon,
  IconMobileOutline24 as MobileIcon,
  IconQrcodeOutline24 as QrCodeIcon,
  IconRefreshOutline24 as RefreshCwIcon,
  IconSpinnerLoaderOutline24 as Loader2Icon,
} from "nucleo-core-outline-24";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { MobilePairingSession, MobilePairingSessionStatus } from "contracts";

import { useMobileAppFeatureEnabled } from "../../featureFlags";
import { cn, resolveServerUrl } from "../../lib/utils";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./SettingsPanels";

type ApiEnvelope<T> =
  | {
      success: true;
      data: T;
    }
  | {
      success: false;
      error: string;
    };

function resolveMobileApiUrl(pathname: string, params: Record<string, string> = {}): string {
  const url = new URL(resolveServerUrl({ protocol: "http", pathname }));
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

async function requestMobileApi<T>(
  pathname: string,
  init?: RequestInit,
  params?: Record<string, string>,
): Promise<T> {
  const response = await fetch(resolveMobileApiUrl(pathname, params), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const body = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || !body.success) {
    throw new Error(body.success ? "Mobile pairing request failed." : body.error);
  }
  return body.data;
}

const PAIRING_STEPS = [
  "Install ShioriCode from the App Store on your iPhone.",
  "Open the app and tap “Pair a desktop”.",
  "Point the camera at the code shown here.",
] as const;

type PairingHeaderState = {
  dot: string;
  label: string;
  pulse?: boolean;
};

function useExpiryCountdown(expiresAt: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [expiresAt]);
  if (!expiresAt) return null;
  const remaining = new Date(expiresAt).getTime() - now;
  return Number.isNaN(remaining) ? null : Math.max(0, remaining);
}

function formatCountdown(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function MobilePairingPanel() {
  const mobileAppEnabled = useMobileAppFeatureEnabled();
  const [session, setSession] = useState<MobilePairingSession | null>(null);
  const [status, setStatus] = useState<MobilePairingSessionStatus | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const remaining = useExpiryCountdown(session?.expiresAt ?? null);
  const expired = remaining !== null && remaining <= 0;
  const canCopyPayload = typeof navigator !== "undefined" && Boolean(navigator.clipboard);

  const headerState = useMemo<PairingHeaderState>(() => {
    if (!mobileAppEnabled) return { dot: "bg-muted-foreground/40", label: "Disabled" };
    if (error) return { dot: "bg-destructive", label: "Error" };
    if (status?.paired) return { dot: "bg-success", label: "Paired" };
    if (expired) return { dot: "bg-warning", label: "Expired" };
    if (session) return { dot: "bg-info", label: "Waiting", pulse: true };
    return { dot: "bg-muted-foreground/40", label: "Loading" };
  }, [mobileAppEnabled, error, status?.paired, expired, session]);

  const createSession = useCallback(async () => {
    setLoading(true);
    setError(null);
    setCopied(false);
    if (!mobileAppEnabled) {
      setSession(null);
      setStatus(null);
      setQrDataUrl(null);
      setLoading(false);
      return;
    }
    try {
      const nextSession = await requestMobileApi<MobilePairingSession>(
        "/api/mobile/pairing-sessions",
        {
          method: "POST",
          body: "{}",
        },
      );
      setSession(nextSession);
      setStatus(null);
      const qr = qrcode(0, "M");
      qr.addData(nextSession.qrPayload, "Byte");
      qr.make();
      setQrDataUrl(qr.createDataURL(8, 1));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to create pairing QR code.");
      setSession(null);
      setStatus(null);
      setQrDataUrl(null);
    } finally {
      setLoading(false);
    }
  }, [mobileAppEnabled]);

  useEffect(() => {
    if (!mobileAppEnabled) {
      return;
    }
    void createSession();
  }, [createSession, mobileAppEnabled]);

  useEffect(() => {
    if (!mobileAppEnabled || !session || status?.paired || expired) {
      return;
    }

    const interval = window.setInterval(() => {
      void requestMobileApi<MobilePairingSessionStatus>(
        "/api/mobile/pairing-sessions/status",
        { method: "GET" },
        { pairingId: session.pairingId },
      )
        .then(setStatus)
        .catch(() => undefined);
    }, 1_500);

    return () => window.clearInterval(interval);
  }, [mobileAppEnabled, session, status?.paired, expired]);

  const copyPayload = useCallback(async () => {
    if (!session?.qrPayload || typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }
    await navigator.clipboard.writeText(session.qrPayload);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_200);
  }, [session?.qrPayload]);

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Mobile App"
        icon={<QrCodeIcon className="size-3.5" />}
        headerAction={
          <div className="flex items-center gap-2">
            {mobileAppEnabled ? (
              <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    headerState.dot,
                    headerState.pulse && "animate-pulse",
                  )}
                />
                {headerState.label}
              </span>
            ) : null}
            <Button
              size="xs"
              variant="outline"
              disabled={loading || !mobileAppEnabled}
              onClick={() => void createSession()}
            >
              {loading ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <RefreshCwIcon className="size-3.5" />
              )}
              New code
            </Button>
          </div>
        }
      >
        {!mobileAppEnabled ? (
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
            <div className="flex size-10 items-center justify-center rounded-lg border bg-muted/40 text-muted-foreground">
              <MobileIcon className="size-5" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">Mobile pairing is disabled</p>
              <p className="mx-auto max-w-sm text-xs leading-5 text-muted-foreground">
                Mobile pairing is currently disabled for this ShioriCode deployment. Enable it from
                your server configuration to pair your iPhone.
              </p>
            </div>
          </div>
        ) : (
          <>
            <SettingsRow
              title="Pair your iPhone"
              description="Scan this code from the ShioriCode iOS app — over the same network, or from anywhere when both devices are on Tailscale."
            >
              <div className="mt-1 grid gap-4 md:grid-cols-[auto_1fr] md:items-start">
                <div className="flex flex-col items-center gap-3">
                  <div className="flex size-56 items-center justify-center rounded-xl border border-border bg-white p-3 shadow-inner sm:size-60">
                    {qrDataUrl ? (
                      <img
                        src={qrDataUrl}
                        alt="ShioriCode mobile pairing QR code"
                        className="size-full rounded-md"
                      />
                    ) : (
                      <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
                    )}
                  </div>
                  {remaining !== null ? (
                    <div
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium tabular-nums",
                        expired || remaining < 30_000
                          ? "border-warning/30 text-warning"
                          : "border-border text-muted-foreground",
                      )}
                    >
                      <ClockIcon className="size-3" />
                      {expired ? "Expired" : `Expires in ${formatCountdown(remaining)}`}
                    </div>
                  ) : null}
                </div>

                <div className="flex min-w-0 flex-col gap-3">
                  {status?.paired ? (
                    <Alert variant="success">
                      <CheckCircle2Icon />
                      <AlertTitle>Paired</AlertTitle>
                      <AlertDescription>
                        {status.pairedDeviceName ?? "Your iPhone"} is connected to this desktop.
                      </AlertDescription>
                    </Alert>
                  ) : expired ? (
                    <Alert variant="warning">
                      <ClockIcon />
                      <AlertTitle>Code expired</AlertTitle>
                      <AlertDescription>
                        This code is no longer valid. Generate a new one to finish pairing.
                      </AlertDescription>
                    </Alert>
                  ) : (
                    <Alert variant="info">
                      <QrCodeIcon />
                      <AlertTitle>Waiting for scan</AlertTitle>
                      <AlertDescription>The code is single-use and short-lived.</AlertDescription>
                    </Alert>
                  )}

                  {error ? (
                    <Alert variant="error">
                      <AlertTitle>Pairing unavailable</AlertTitle>
                      <AlertDescription>{error}</AlertDescription>
                    </Alert>
                  ) : null}

                  {status?.paired ? (
                    <p className="text-xs leading-5 text-muted-foreground">
                      You can now start threads, watch runs, and approve actions from your iPhone.
                    </p>
                  ) : (
                    <ol className="space-y-2">
                      {PAIRING_STEPS.map((step, index) => (
                        <li key={step} className="flex items-start gap-2.5">
                          <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-muted/40 text-[11px] font-medium text-muted-foreground">
                            {index + 1}
                          </span>
                          <span className="text-xs leading-5 text-muted-foreground">{step}</span>
                        </li>
                      ))}
                    </ol>
                  )}

                  <div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!session?.qrPayload || !canCopyPayload}
                      onClick={() => void copyPayload()}
                    >
                      <CopyIcon className="size-3.5" />
                      {copied ? "Copied" : "Copy pairing payload"}
                    </Button>
                  </div>
                </div>
              </div>
            </SettingsRow>
          </>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
