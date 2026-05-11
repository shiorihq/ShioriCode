import qrcode from "qrcode-generator";
import {
  IconCircleCheckOutline24 as CheckCircle2Icon,
  IconCopyOutline24 as CopyIcon,
  IconSpinnerLoaderOutline24 as Loader2Icon,
  IconQrcodeOutline24 as QrCodeIcon,
  IconRefreshOutline24 as RefreshCwIcon,
} from "nucleo-core-outline-24";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { MobilePairingSession, MobilePairingSessionStatus } from "contracts";

import { useHostedShioriState } from "../../convex/HostedShioriProvider";
import { resolveServerUrl } from "../../lib/utils";
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

export function MobilePairingPanel() {
  const { mobileAppEnabled } = useHostedShioriState();
  const [session, setSession] = useState<MobilePairingSession | null>(null);
  const [status, setStatus] = useState<MobilePairingSessionStatus | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const expiresAtLabel = useMemo(() => {
    if (!session) return null;
    return new Date(session.expiresAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }, [session]);

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
    if (!mobileAppEnabled || !session || status?.paired) {
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
  }, [mobileAppEnabled, session, status?.paired]);

  const copyPayload = useCallback(async () => {
    if (!session?.qrPayload || !navigator.clipboard) {
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
          <Button
            size="xs"
            variant="outline"
            disabled={loading}
            onClick={() => void createSession()}
          >
            {loading ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-3.5" />
            )}
            New code
          </Button>
        }
      >
        <SettingsRow
          title="Pair iPhone"
          description="Open ShioriCode on iPhone and scan this code while both devices are on the same network."
          status={expiresAtLabel ? `Expires at ${expiresAtLabel}` : undefined}
        >
          {!mobileAppEnabled ? (
            <Alert variant="warning" className="m-4">
              <QrCodeIcon />
              <AlertTitle>Mobile app disabled</AlertTitle>
              <AlertDescription>
                Mobile pairing is currently disabled for this Shiori deployment.
              </AlertDescription>
            </Alert>
          ) : null}

          {mobileAppEnabled ? (
            <div className="mt-4 grid gap-4 md:grid-cols-[auto_1fr]">
              <div className="flex min-h-72 items-center justify-center rounded-xl border border-border bg-white p-4 shadow-inner">
                {qrDataUrl ? (
                  <img
                    src={qrDataUrl}
                    alt="ShioriCode mobile pairing QR code"
                    className="size-64 max-w-full rounded-md"
                  />
                ) : (
                  <div className="flex size-64 items-center justify-center text-muted-foreground">
                    <Loader2Icon className="size-6 animate-spin" />
                  </div>
                )}
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
                ) : (
                  <Alert variant="info">
                    <QrCodeIcon />
                    <AlertTitle>Waiting for scan</AlertTitle>
                    <AlertDescription>
                      The code is one-use and short-lived. Create a new code if the iPhone cannot
                      reach this desktop.
                    </AlertDescription>
                  </Alert>
                )}

                {error ? (
                  <Alert variant="error">
                    <AlertTitle>Pairing unavailable</AlertTitle>
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                ) : null}

                <div className="rounded-xl border border-border bg-muted/25 p-3">
                  <div className="text-xs font-medium text-muted-foreground">Addresses in code</div>
                  <div className="mt-2 space-y-1">
                    {session?.candidates.map((candidate) => (
                      <div
                        key={candidate.apiBaseUrl}
                        className="flex min-w-0 items-center justify-between gap-2 text-xs"
                      >
                        <span className="truncate text-foreground">{candidate.apiBaseUrl}</span>
                        <span className="shrink-0 text-muted-foreground">{candidate.label}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <Button
                  size="sm"
                  variant="outline"
                  disabled={!session?.qrPayload || !navigator.clipboard}
                  onClick={() => void copyPayload()}
                >
                  <CopyIcon className="size-3.5" />
                  {copied ? "Copied" : "Copy pairing payload"}
                </Button>
              </div>
            </div>
          ) : null}
        </SettingsRow>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
