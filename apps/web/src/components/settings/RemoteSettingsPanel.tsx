import {
  IconBoltOutline24 as SignalIcon,
  IconCircleCheckOutline24 as CheckCircleIcon,
  IconCircleXmarkOutline24 as XCircleIcon,
  IconGlobeOutline24 as GlobeIcon,
  IconMobileOutline24 as DeviceIcon,
  IconRefreshOutline24 as RefreshIcon,
  IconSpinnerLoaderOutline24 as LoaderIcon,
} from "nucleo-core-outline-24";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RemoteExposureMethod, RemoteProbeResult, RemoteStatus } from "contracts";

import { getWsRpcClient } from "../../wsRpcClient";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { RemoteSetupWizard } from "./RemoteSetupWizard";
import { RemoteUrlCard } from "./RemoteUrlCard";
import type { WizardMethod } from "./remoteSetup.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./SettingsPanels";

const EXPOSURE_OPTIONS: ReadonlyArray<{
  value: RemoteExposureMethod;
  label: string;
  hint: string;
}> = [
  { value: "off", label: "Off", hint: "This machine only" },
  { value: "tailscale-serve", label: "My devices", hint: "Private · via your tailnet" },
  { value: "tailscale-funnel", label: "Public link", hint: "Anywhere · behind sign-in" },
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
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardMethod, setWizardMethod] = useState<WizardMethod | undefined>(undefined);
  const [testResult, setTestResult] = useState<RemoteProbeResult | null>(null);
  const [testing, setTesting] = useState(false);
  const autoOpenedRef = useRef(false);

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
        if (cancelled) return;
        setStatus(next);
        // First visit with nothing configured: drop straight into the wizard.
        if (!autoOpenedRef.current && next.desiredMethod === "off" && !next.enabled) {
          autoOpenedRef.current = true;
          setWizardOpen(true);
        }
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

  const runTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await getWsRpcClient().remote.testConnection());
    } catch (cause) {
      setTestResult({
        ok: false,
        url: null,
        latencyMs: null,
        error: cause instanceof Error ? cause.message : "Test failed.",
      });
    } finally {
      setTesting(false);
    }
  }, []);

  const openWizard = useCallback((method?: WizardMethod) => {
    setWizardMethod(method);
    setWizardOpen(true);
  }, []);

  const tailscale = status?.tailscale;
  const canServe = Boolean(tailscale?.installed);
  const canFunnel = Boolean(tailscale?.installed && tailscale.httpsEnabled);
  const drifted = Boolean(
    status && status.desiredMethod !== "off" && status.desiredMethod !== status.method,
  );

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
      {/* ── Status / wizard card ─────────────────────────────────── */}
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
        {wizardOpen && status ? (
          <RemoteSetupWizard
            key={wizardMethod ?? "default"}
            status={status}
            onStatus={setStatus}
            onClose={() => {
              setWizardOpen(false);
              setWizardMethod(undefined);
            }}
            {...(wizardMethod !== undefined ? { initialMethod: wizardMethod } : {})}
          />
        ) : (
          <SettingsRow
            title="Reach ShioriCode from your phone and other devices"
            description="The server keeps running on this machine; remote access only changes how devices reach it. Anyone who signs in has full access — keep the password strong."
            status={
              status?.enabled && status.url
                ? `${status.sessions.length} device${status.sessions.length === 1 ? "" : "s"} connected`
                : undefined
            }
            control={
              <Button size="sm" variant="outline" disabled={busy} onClick={() => openWizard()}>
                {status?.enabled ? "Run setup again" : "Set up remote access"}
              </Button>
            }
          >
            {error ? (
              <Alert variant="error" className="mb-3">
                <AlertTitle>Couldn't complete that</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            {drifted && status ? (
              <Alert variant="warning" className="mb-3">
                <AlertTitle>Remote access was interrupted</AlertTitle>
                <AlertDescription>
                  <div className="flex flex-wrap items-center gap-2">
                    <span>
                      {status.notice ?? "The exposure no longer matches what you set up."}
                    </span>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void setExposure(status.desiredMethod)}
                    >
                      Repair
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            ) : null}

            {status?.enabled && status.url ? (
              <div className="space-y-3">
                <RemoteUrlCard url={status.url} />
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={testing}
                    onClick={() => void runTest()}
                  >
                    {testing ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
                    Test connection
                  </Button>
                  {testResult ? (
                    <span
                      className={`inline-flex items-center gap-1 text-xs ${
                        testResult.ok
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-destructive"
                      }`}
                    >
                      {testResult.ok ? (
                        <CheckCircleIcon className="size-3.5" />
                      ) : (
                        <XCircleIcon className="size-3.5" />
                      )}
                      {testResult.ok
                        ? `Reachable${testResult.latencyMs !== null ? ` · ${testResult.latencyMs}ms` : ""}`
                        : (testResult.error ?? "Not reachable.")}
                    </span>
                  ) : null}
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Not exposed yet. Use the setup wizard to get a link in about a minute.
              </p>
            )}

            {status?.notice && !drifted ? (
              <Alert variant="warning" className="mt-3">
                <AlertDescription>{status.notice}</AlertDescription>
              </Alert>
            ) : null}
          </SettingsRow>
        )}
      </SettingsSection>

      {!wizardOpen ? (
        <>
          {/* ── Exposure method ─────────────────────────────────────── */}
          <SettingsSection title="How it's reached" icon={<SignalIcon className="size-3.5" />}>
            <SettingsRow
              title="Access method"
              description={
                tailscale?.installed
                  ? tailscale.running
                    ? "Tailscale is connected on this machine."
                    : "Tailscale is installed but not connected — open the Tailscale app or run `tailscale up`."
                  : "Remote access runs over Tailscale — install it (free) and this machine is reachable with no ports, DNS, or certificates to manage."
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
              {tailscale && !tailscale.installed ? (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  <a
                    href="https://tailscale.com/download"
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:underline"
                  >
                    Download Tailscale
                  </a>{" "}
                  and sign in, then come back — the setup wizard checks it live.
                </p>
              ) : null}
              {canFunnel || status?.method === "tailscale-funnel" ? null : tailscale?.installed &&
                !tailscale.httpsEnabled ? (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Public access needs HTTPS certificates enabled on your tailnet (admin console →
                  DNS → Enable HTTPS).
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
                  : "Set a password so the iOS app and remote browsers can sign in. It's required the moment you expose this machine."
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
        </>
      ) : null}
    </SettingsPageContainer>
  );
}
