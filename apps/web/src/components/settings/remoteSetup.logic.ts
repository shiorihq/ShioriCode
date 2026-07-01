/**
 * Pure logic for the remote-access setup wizard: which exposure methods exist,
 * their prerequisite checks against a RemoteStatus snapshot, and client-side
 * input validation. Kept free of React so it can be unit-tested directly.
 */
import type { RemoteStatus } from "contracts";

export type WizardMethod = "tailscale-serve" | "tailscale-funnel" | "custom";

export type WizardStepId = "method" | "prerequisites" | "credentials" | "enable";

export const WIZARD_STEPS: ReadonlyArray<{ id: WizardStepId; title: string }> = [
  { id: "method", title: "How it's reached" },
  { id: "prerequisites", title: "Get ready" },
  { id: "credentials", title: "Sign-in" },
  { id: "enable", title: "Turn on" },
];

export const METHOD_CHOICES: ReadonlyArray<{
  value: WizardMethod;
  label: string;
  badge: string;
  description: string;
}> = [
  {
    value: "tailscale-serve",
    label: "Tailscale",
    badge: "Private · recommended",
    description:
      "Only devices signed into your tailnet can reach it. No ports, DNS, or certificates to manage.",
  },
  {
    value: "tailscale-funnel",
    label: "Tailscale Funnel",
    badge: "Public link",
    description:
      "A public https://….ts.net address anyone can open — sign-in still protects it. Zero infrastructure.",
  },
  {
    value: "custom",
    label: "Custom server",
    badge: "Your own domain",
    description:
      "You already run a reverse proxy, VPS, or tunnel (nginx, Caddy, Cloudflare Tunnel…). ShioriCode just needs the URL.",
  },
];

export interface PrereqCheck {
  readonly id: string;
  readonly label: string;
  readonly ok: boolean;
  /** What to do when the check fails. */
  readonly hint: string | null;
  /** A link that helps resolve the failing check. */
  readonly href: string | null;
}

/** Prerequisite checklist for a method, derived from the latest status. */
export function prerequisiteChecks(
  method: WizardMethod,
  status: Pick<RemoteStatus, "tailscale">,
): PrereqCheck[] {
  if (method === "custom") {
    return [];
  }
  const tailscale = status.tailscale;
  const checks: PrereqCheck[] = [
    {
      id: "installed",
      label: "Tailscale is installed",
      ok: tailscale.installed,
      hint: tailscale.installed ? null : "Install Tailscale on this machine, then check again.",
      href: tailscale.installed ? null : "https://tailscale.com/download",
    },
    {
      id: "running",
      label: "Tailscale is connected",
      ok: tailscale.running,
      hint: tailscale.running
        ? null
        : tailscale.backendState === "NeedsLogin"
          ? "Open the Tailscale app and sign in (or run `tailscale up`)."
          : "Open the Tailscale app or run `tailscale up`.",
      href: null,
    },
  ];
  if (method === "tailscale-funnel") {
    checks.push({
      id: "https",
      label: "HTTPS certificates are enabled on your tailnet",
      ok: tailscale.httpsEnabled,
      hint: tailscale.httpsEnabled
        ? null
        : "In the Tailscale admin console, open DNS and enable HTTPS certificates.",
      href: tailscale.httpsEnabled ? null : "https://login.tailscale.com/admin/dns",
    });
  }
  return checks;
}

export function prerequisitesSatisfied(
  method: WizardMethod,
  status: Pick<RemoteStatus, "tailscale">,
): boolean {
  return prerequisiteChecks(method, status).every((check) => check.ok);
}

/**
 * Client-side validation of a custom URL (mirrors the server's rules so the
 * wizard can catch mistakes before the round-trip). Returns an error message,
 * or null when the input is acceptable.
 */
export function validateCustomUrlInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "Enter the URL your reverse proxy or tunnel serves ShioriCode on.";
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return `"${trimmed}" isn't a valid URL.`;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "The URL must start with https:// (or http://).";
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    return "Use the bare origin (e.g. https://code.example.com) — subpaths aren't supported.";
  }
  return null;
}

export const MIN_PASSWORD_LENGTH = 8;

/**
 * Validate the credentials step. `keepExisting` skips validation when a
 * credential is already configured and the owner chose to keep it.
 */
export function credentialsIssue(input: {
  readonly username: string;
  readonly password: string;
  readonly confirm: string;
  readonly keepExisting: boolean;
}): string | null {
  if (input.keepExisting) {
    return null;
  }
  if (!input.username.trim()) {
    return "Pick a username.";
  }
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters — this password is the only thing between the internet and this machine.`;
  }
  if (input.password !== input.confirm) {
    return "Passwords don't match.";
  }
  return null;
}
