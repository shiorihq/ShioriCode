import qrcode from "qrcode-generator";
import {
  IconBoltOutline24 as SignalIcon,
  IconCircleCheckOutline24 as CheckCircleIcon,
  IconCopyOutline24 as CopyIcon,
  IconGlobeOutline24 as GlobeIcon,
  IconMobileOutline24 as DeviceIcon,
  IconQrcodeOutline24 as QrCodeIcon,
  IconRefreshOutline24 as RefreshIcon,
  IconSpinnerLoaderOutline24 as LoaderIcon,
} from "nucleo-core-outline-24";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { RemoteExposureMethod, RemoteStatus } from "contracts";

import { getWsRpcClient } from "../../wsRpcClient";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./SettingsPanels";

const EXPOSURE_OPTIONS: ReadonlyArray<{
  value: RemoteExposureMethod;
  label: string;
  hint: string;
}> = [
  { value: "off", label: "Off", hint: "This machine only" },
  { value: "tailscale-serve", label: "Tailscale", hint: "Private · your devices" },
  { value: "tailscale-funnel", label: "Public", hint: "Anyone with the link" },
];

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unknown";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function RemoteSettingsPanel() {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [copied, setCopied] = useState(false);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      setStatus(await getWsRpcClient().remote.getStatus());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load remote status.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getWsRpcClient()
      .remote.getStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Failed to load remote status.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (status?.username) setUsername(status.username);
  }, [status?.username]);

  useEffect(() => {
    if (!status?.url) {
      setQrDataUrl(null);
      return;
    }
    const qr = qrcode(0, "M");
    qr.addData(status.url, "Byte");
    qr.make();
    setQrDataUrl(qr.createDataURL(7, 2));
  }, [status?.url]);

  const runAction = useCallback(async (fn: () => Promise<RemoteStatus>) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await fn());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }, []);

  const setExposure = useCallback(
    (method: RemoteExposureMethod) =>
      runAction(() => getWsRpcClient().remote.setExposure({ method })),
    [runAction],
  );

  const saveCredentials = useCallback(
    () =>
      runAction(() =>
        getWsRpcClient()
          .remote.setCredentials({ username: username.trim(), password })
          .then((next) => {
            setPassword("");
            return next;
          }),
      ),
    [runAction, username, password],
  );

  const revokeSession = useCallback(
    (sessionId: string) => runAction(() => getWsRpcClient().remote.revokeSession({ sessionId })),
    [runAction],
  );

  const copyUrl = useCallback(async () => {
    if (!status?.url || typeof navigator === "undefined" || !navigator.clipboard) return;
    await navigator.clipboard.writeText(status.url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_200);
  }, [status?.url]);

  const tailscale = status?.tailscale;
  const canServe = Boolean(tailscale?.installed);
  const canFunnel = Boolean(tailscale?.installed && tailscale.httpsEnabled);
  const canCopyUrl = typeof navigator !== "undefined" && Boolean(navigator.clipboard);

  const stateLabel = useMemo(() => {
    if (!status) return "…";
    if (!status.enabled) return "Off";
    return status.reachability === "public" ? "Public" : "Live";
  }, [status]);

  if (loading) {
    return (
      <SettingsPageContainer>
        <div className="flex items-center gap-2 px-1 py-8 text-sm text-muted-foreground">
          <LoaderIcon className="size-4 animate-spin" />
          Loading remote access…
        </div>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      {/* ── Status card ─────────────────────────────────────────── */}
      <SettingsSection
        title="Remote access"
        icon={<GlobeIcon className="size-3.5" />}
        headerAction={
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${
                status?.enabled ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"
              }`}
            >
              <span
                className={`size-1.5 rounded-full ${
                  status?.enabled ? "bg-emerald-500" : "bg-muted-foreground/50"
                }`}
              />
              {stateLabel}
            </span>
            <Button
              size="xs"
              variant="outline"
              disabled={busy || refreshing}
              onClick={() => void refresh()}
            >
              <RefreshIcon className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />
            </Button>
          </div>
        }
      >
        <SettingsRow
          title="Reach ShioriCode from your phone and other devices"
          description="The server keeps running on this machine; remote access only changes how devices reach it. Anyone who signs in has full access — keep the password strong."
          status={
            status?.enabled && status.url
              ? `${status.sessions.length} device${status.sessions.length === 1 ? "" : "s"} connected`
              : undefined
          }
        >
          {error ? (
            <Alert variant="error" className="mb-3">
              <AlertTitle>Couldn't complete that</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          {status?.enabled && status.url ? (
            <div className="space-y-3">
              <div className="flex min-w-0 items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
                  {status.url}
                </code>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canCopyUrl}
                  onClick={() => void copyUrl()}
                >
                  {copied ? (
                    <CheckCircleIcon className="size-3.5" />
                  ) : (
                    <CopyIcon className="size-3.5" />
                  )}
                  {copied ? "Copied" : "Copy"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setShowQr((v) => !v)}>
                  <QrCodeIcon className="size-3.5" />
                  QR
                </Button>
              </div>
              {showQr && qrDataUrl ? (
                <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-white p-4">
                  <img
                    src={qrDataUrl}
                    alt="Remote access QR code"
                    className="size-56 max-w-full rounded-md"
                  />
                  <p className="text-center text-xs text-muted-foreground">
                    Scan with the iOS app to prefill Remote Server, or open it in a browser.
                  </p>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Not exposed yet. Choose how it&apos;s reached below to get a link.
            </p>
          )}

          {status?.notice ? (
            <Alert variant="warning" className="mt-3">
              <AlertDescription>{status.notice}</AlertDescription>
            </Alert>
          ) : null}
        </SettingsRow>
      </SettingsSection>

      {/* ── Exposure method ─────────────────────────────────────── */}
      <SettingsSection title="How it's reached" icon={<SignalIcon className="size-3.5" />}>
        <SettingsRow
          title="Access method"
          description={
            tailscale?.installed
              ? tailscale.running
                ? "Tailscale is connected on this machine."
                : "Tailscale is installed but not connected — run `tailscale up`."
              : "Install Tailscale to expose this machine privately, with no router setup."
          }
        >
          <div className="mt-1 grid gap-2 sm:grid-cols-3">
            {EXPOSURE_OPTIONS.map((option) => {
              const active = status?.method === option.value;
              const disabled =
                busy ||
                (option.value === "tailscale-serve" && !canServe) ||
                (option.value === "tailscale-funnel" && !canFunnel);
              return (
                <button
                  key={option.value}
                  type="button"
                  disabled={disabled}
                  onClick={() => void setExposure(option.value)}
                  className={`flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    active
                      ? "border-primary bg-primary/5 ring-1 ring-primary"
                      : "border-border hover:bg-muted/40"
                  }`}
                >
                  <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                    {active ? <CheckCircleIcon className="size-3.5 text-primary" /> : null}
                    {option.label}
                  </span>
                  <span className="text-[11px] text-muted-foreground">{option.hint}</span>
                </button>
              );
            })}
          </div>
          {status?.method === "tailscale-funnel" || canFunnel ? null : tailscale?.installed &&
            !tailscale.httpsEnabled ? (
            <p className="mt-2 text-[11px] text-muted-foreground">
              Public access needs HTTPS certificates enabled on your tailnet (admin console → DNS →
              Enable HTTPS).
            </p>
          ) : null}
        </SettingsRow>
      </SettingsSection>

      {/* ── Sign-in ─────────────────────────────────────────────── */}
      <SettingsSection title="Sign-in">
        <SettingsRow
          title="Owner credentials"
          description={
            status?.requireAuth
              ? "A login is required for remote access."
              : "Set a password so the iOS app and remote browsers can sign in."
          }
          status={
            status?.authConfigured
              ? `Configured${status.username ? ` · ${status.username}` : ""}`
              : "Not set"
          }
        >
          <div className="mt-1 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="remote-username">Username</Label>
              <Input
                id="remote-username"
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                disabled={busy}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="remote-password">
                {status?.authConfigured ? "New password" : "Password"}
              </Label>
              <Input
                id="remote-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={busy}
              />
            </div>
            <Button
              disabled={busy || username.trim().length === 0 || password.length === 0}
              onClick={() => void saveCredentials()}
            >
              {status?.authConfigured ? "Update" : "Set password"}
            </Button>
          </div>
        </SettingsRow>
      </SettingsSection>

      {/* ── Devices ─────────────────────────────────────────────── */}
      <SettingsSection title="Devices" icon={<DeviceIcon className="size-3.5" />}>
        <SettingsRow
          title="Connected devices"
          description="Sessions that have signed in remotely. Revoke one to sign it out immediately."
        >
          {status && status.sessions.length > 0 ? (
            <div className="mt-1 divide-y divide-border rounded-lg border border-border">
              {status.sessions.map((session) => (
                <div
                  key={session.id}
                  className="flex min-w-0 items-center justify-between gap-3 px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm text-foreground">
                      {session.label ?? session.username}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      last seen {relativeTime(session.lastSeenAt)}
                    </div>
                  </div>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void revokeSession(session.id)}
                  >
                    Revoke
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">No devices connected yet.</p>
          )}
        </SettingsRow>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
