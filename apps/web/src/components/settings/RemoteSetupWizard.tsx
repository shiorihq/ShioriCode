import {
  IconArrowLeftOutline24 as ArrowLeftIcon,
  IconCircleCheckOutline24 as CheckCircleIcon,
  IconCircleXmarkOutline24 as XCircleIcon,
  IconExternalLinkOutline24 as ExternalLinkIcon,
  IconRefreshOutline24 as RefreshIcon,
  IconSpinnerLoaderOutline24 as LoaderIcon,
} from "nucleo-core-outline-24";
import { useCallback, useEffect, useState } from "react";
import type { RemoteProbeResult, RemoteStatus } from "contracts";

import { login as authLogin } from "../../auth/authClient";
import { getWsRpcClient } from "../../wsRpcClient";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { RemoteUrlCard } from "./RemoteUrlCard";
import {
  METHOD_CHOICES,
  WIZARD_STEPS,
  type WizardMethod,
  type WizardStepId,
  credentialsIssue,
  prerequisiteChecks,
  validateCustomUrlInput,
} from "./remoteSetup.logic";

const PREREQ_POLL_MS = 4_000;

interface RemoteSetupWizardProps {
  status: RemoteStatus;
  /** Push a fresh status snapshot up so the dashboard stays in sync. */
  onStatus: (next: RemoteStatus) => void;
  onClose: () => void;
  initialMethod?: WizardMethod;
}

/**
 * Guided setup for remote access: pick how the machine is reached, satisfy the
 * prerequisites (with live re-checking), create the owner sign-in (and sign
 * this browser in silently so it survives the auth flip), then turn exposure
 * on and verify it.
 */
export function RemoteSetupWizard({
  status,
  onStatus,
  onClose,
  initialMethod,
}: RemoteSetupWizardProps) {
  const [step, setStep] = useState<WizardStepId>("method");
  const [method, setMethod] = useState<WizardMethod>(initialMethod ?? "tailscale-serve");
  const [customUrl, setCustomUrl] = useState(status.customUrl ?? "");
  const [username, setUsername] = useState(status.username ?? "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [keepExisting, setKeepExisting] = useState(status.authConfigured);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [testResult, setTestResult] = useState<RemoteProbeResult | null>(null);
  const [testing, setTesting] = useState(false);

  const stepIndex = WIZARD_STEPS.findIndex((s) => s.id === step);

  const refreshStatus = useCallback(async () => {
    try {
      onStatus(await getWsRpcClient().remote.getStatus());
    } catch {
      // transient; the next poll or manual check will recover
    }
  }, [onStatus]);

  // Live re-checking while the owner installs/starts Tailscale in parallel.
  useEffect(() => {
    if (step !== "prerequisites" || method === "custom") {
      return;
    }
    const timer = window.setInterval(() => void refreshStatus(), PREREQ_POLL_MS);
    return () => window.clearInterval(timer);
  }, [step, method, refreshStatus]);

  const goBack = useCallback(() => {
    setError(null);
    const previous = WIZARD_STEPS[stepIndex - 1];
    if (previous && !enabled) {
      setStep(previous.id);
    }
  }, [stepIndex, enabled]);

  const continueFromMethod = useCallback(() => {
    setError(null);
    setStep("prerequisites");
  }, []);

  const continueFromPrerequisites = useCallback(() => {
    setError(null);
    if (method === "custom") {
      const issue = validateCustomUrlInput(customUrl);
      if (issue) {
        setError(issue);
        return;
      }
    }
    setStep("credentials");
  }, [method, customUrl]);

  const continueFromCredentials = useCallback(async () => {
    setError(null);
    const issue = credentialsIssue({ username, password, confirm, keepExisting });
    if (issue) {
      setError(issue);
      return;
    }
    if (keepExisting) {
      setStep("enable");
      return;
    }
    setBusy(true);
    try {
      onStatus(
        await getWsRpcClient().remote.setCredentials({ username: username.trim(), password }),
      );
      // Sign this browser in right away: once exposure turns on, every client
      // needs a session — this keeps the local UI from bouncing to the login
      // screen after the next reload.
      await authLogin(username.trim(), password);
      setPassword("");
      setConfirm("");
      setStep("enable");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't save the credentials.");
    } finally {
      setBusy(false);
    }
  }, [username, password, confirm, keepExisting, onStatus]);

  const turnOn = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const next = await getWsRpcClient().remote.setExposure({
        method,
        ...(method === "custom" ? { customUrl: customUrl.trim() } : {}),
      });
      onStatus(next);
      setEnabled(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't turn on remote access.");
    } finally {
      setBusy(false);
    }
  }, [method, customUrl, onStatus]);

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

  const checks = prerequisiteChecks(method, status);
  const checksPass = checks.every((check) => check.ok);
  const methodChoice = METHOD_CHOICES.find((choice) => choice.value === method);

  return (
    <div className="space-y-4 px-4 py-4 sm:px-5">
      {/* Step indicator */}
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
        {WIZARD_STEPS.map((s, index) => {
          const state = index < stepIndex ? "done" : index === stepIndex ? "current" : "upcoming";
          return (
            <li key={s.id} className="flex items-center gap-2">
              {index > 0 ? <span className="text-muted-foreground/40">—</span> : null}
              <span
                className={
                  state === "current"
                    ? "font-medium text-foreground"
                    : state === "done"
                      ? "text-primary"
                      : "text-muted-foreground"
                }
              >
                {index + 1}. {s.title}
              </span>
            </li>
          );
        })}
      </ol>

      {error ? (
        <Alert variant="error">
          <AlertTitle>Couldn't continue</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {/* ── Step 1: method ─────────────────────────────────────── */}
      {step === "method" ? (
        <div className="space-y-3">
          <div className="grid gap-2">
            {METHOD_CHOICES.map((choice) => {
              const active = method === choice.value;
              return (
                <button
                  key={choice.value}
                  type="button"
                  onClick={() => setMethod(choice.value)}
                  className={`flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    active
                      ? "border-primary bg-primary/5 ring-1 ring-primary"
                      : "border-border hover:bg-muted/40"
                  }`}
                >
                  <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                    {active ? <CheckCircleIcon className="size-3.5 text-primary" /> : null}
                    {choice.label}
                    <span className="rounded-full border border-border px-1.5 py-px text-[10px] font-normal text-muted-foreground">
                      {choice.badge}
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground">{choice.description}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* ── Step 2: prerequisites ──────────────────────────────── */}
      {step === "prerequisites" && method !== "custom" ? (
        <div className="space-y-3">
          <ul className="divide-y divide-border rounded-lg border border-border">
            {checks.map((check) => (
              <li key={check.id} className="flex items-start gap-2.5 px-3 py-2.5">
                {check.ok ? (
                  <CheckCircleIcon className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                ) : (
                  <XCircleIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0 space-y-0.5">
                  <div className="text-sm text-foreground">{check.label}</div>
                  {!check.ok && check.hint ? (
                    <div className="text-xs text-muted-foreground">
                      {check.hint}{" "}
                      {check.href ? (
                        <a
                          href={check.href}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-0.5 text-primary hover:underline"
                        >
                          Open
                          <ExternalLinkIcon className="size-3" />
                        </a>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <RefreshIcon className="size-3 animate-spin [animation-duration:3s]" />
            Checking automatically — finish the steps above and they'll turn green.
          </p>
        </div>
      ) : null}

      {step === "prerequisites" && method === "custom" ? (
        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
            Point your reverse proxy or tunnel at{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-foreground">
              http://127.0.0.1:{status.port}
            </code>{" "}
            on this machine, then enter the public URL it serves. For example:
            <pre className="mt-2 overflow-x-auto rounded-md bg-muted px-2.5 py-2 text-[11px] leading-5 text-foreground">
              {`# Caddy\ncode.example.com {\n  reverse_proxy 127.0.0.1:${status.port}\n}\n\n# Cloudflare Tunnel\ncloudflared tunnel --url http://127.0.0.1:${status.port}`}
            </pre>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wizard-custom-url">Public URL</Label>
            <Input
              id="wizard-custom-url"
              placeholder="https://code.example.com"
              value={customUrl}
              onChange={(event) => setCustomUrl(event.target.value)}
              disabled={busy}
            />
            <p className="text-[11px] text-muted-foreground">
              Use HTTPS — sign-in credentials travel over this URL.
            </p>
          </div>
        </div>
      ) : null}

      {/* ── Step 3: credentials ────────────────────────────────── */}
      {step === "credentials" ? (
        <div className="space-y-3">
          {status.authConfigured ? (
            <Alert variant="info">
              <AlertDescription>
                A sign-in is already set{status.username ? ` for “${status.username}”` : ""}.{" "}
                <button
                  type="button"
                  className="font-medium text-primary hover:underline"
                  onClick={() => setKeepExisting((v) => !v)}
                >
                  {keepExisting ? "Set a new one instead" : "Keep the existing one"}
                </button>
              </AlertDescription>
            </Alert>
          ) : (
            <p className="text-xs text-muted-foreground">
              This username and password is what you'll type on your phone or any remote browser.
              Anyone who signs in has full access to this machine — make it strong.
            </p>
          )}
          {!keepExisting ? (
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="wizard-username">Username</Label>
                <Input
                  id="wizard-username"
                  autoComplete="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  disabled={busy}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wizard-password">Password</Label>
                <Input
                  id="wizard-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={busy}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wizard-confirm">Confirm password</Label>
                <Input
                  id="wizard-confirm"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  disabled={busy}
                />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ── Step 4: enable & verify ────────────────────────────── */}
      {step === "enable" ? (
        <div className="space-y-3">
          {!enabled ? (
            <>
              <p className="text-xs text-muted-foreground">
                Ready to go:{" "}
                <span className="font-medium text-foreground">{methodChoice?.label}</span>
                {method === "custom" ? (
                  <>
                    {" "}
                    at <code className="rounded bg-muted px-1 py-0.5">{customUrl.trim()}</code>
                  </>
                ) : null}
                . Sign-in required for every device.
                {method === "tailscale-funnel"
                  ? " The first public request can take a minute while Tailscale provisions the TLS certificate."
                  : ""}
              </p>
              <Button disabled={busy} onClick={() => void turnOn()}>
                {busy ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
                Turn on remote access
              </Button>
            </>
          ) : (
            <>
              <Alert variant="success">
                <AlertTitle>Remote access is on</AlertTitle>
                <AlertDescription>
                  {status.url
                    ? "Open this URL on your phone or another device and sign in."
                    : "Waiting for the URL — refresh in a moment."}
                </AlertDescription>
              </Alert>
              {status.url ? <RemoteUrlCard url={status.url} /> : null}
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
                      testResult.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"
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
            </>
          )}
        </div>
      ) : null}

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-border pt-3">
        <div>
          {stepIndex > 0 && !enabled ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={goBack}>
              <ArrowLeftIcon className="size-3.5" />
              Back
            </Button>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>
            {enabled ? "Done" : "Cancel"}
          </Button>
          {step === "method" ? (
            <Button size="sm" onClick={continueFromMethod}>
              Continue
            </Button>
          ) : null}
          {step === "prerequisites" ? (
            <Button
              size="sm"
              disabled={busy || (method !== "custom" && !checksPass)}
              onClick={continueFromPrerequisites}
            >
              Continue
            </Button>
          ) : null}
          {step === "credentials" ? (
            <Button size="sm" disabled={busy} onClick={() => void continueFromCredentials()}>
              {busy ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
              Continue
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
