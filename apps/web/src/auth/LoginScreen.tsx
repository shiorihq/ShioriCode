import { useState, type FormEvent } from "react";

import { APP_DISPLAY_NAME } from "../branding";
import { GitHubIcon } from "../components/Icons";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Spinner } from "../components/ui/spinner";
import { hostedLinkSignInUrl, login } from "./authClient";

export function LoginScreen({
  authMode,
  onSuccess,
}: {
  authMode: "credentials" | "shioricode-link";
  onSuccess: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const canReturnToLocal =
    typeof window !== "undefined" &&
    typeof window.desktopBridge?.disconnectFromRemote === "function";

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    const result = await login(username, password);
    if (result.ok) {
      onSuccess();
      return;
    }
    setError(result.error ?? "Login failed.");
    setSubmitting(false);
  };

  if (authMode === "shioricode-link") {
    return (
      <div className="flex h-screen items-center justify-center bg-background p-6 text-foreground">
        <div className="w-full max-w-sm space-y-5 rounded-xl border border-border bg-card p-8 shadow-sm">
          <div className="space-y-1">
            <h1 className="text-lg font-semibold">ShioriCode Link</h1>
            <p className="text-sm text-muted-foreground">
              Sign in with the GitHub account that owns this environment.
            </p>
          </div>
          <Button
            type="button"
            className="w-full gap-2"
            onClick={() => window.location.assign(hostedLinkSignInUrl())}
          >
            <GitHubIcon className="size-4" />
            Continue with GitHub
          </Button>
          {canReturnToLocal ? (
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={() => void window.desktopBridge?.disconnectFromRemote?.()}
            >
              Use this Mac instead
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen items-center justify-center bg-background p-6 text-foreground">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm space-y-5 rounded-xl border border-border bg-card p-8 shadow-sm"
      >
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">{APP_DISPLAY_NAME}</h1>
          <p className="text-sm text-muted-foreground">Sign in to access this server remotely.</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="login-username">Username</Label>
          <Input
            id="login-username"
            autoFocus
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            disabled={submitting}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="login-password">Password</Label>
          <Input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={submitting}
          />
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Button type="submit" className="w-full" disabled={submitting || !username || !password}>
          {submitting ? <Spinner className="size-4" /> : "Sign in"}
        </Button>
        {canReturnToLocal ? (
          <Button
            type="button"
            variant="ghost"
            className="w-full"
            disabled={submitting}
            onClick={() => void window.desktopBridge?.disconnectFromRemote?.()}
          >
            Use this Mac instead
          </Button>
        ) : null}
      </form>
    </div>
  );
}
