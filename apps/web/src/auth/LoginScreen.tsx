import { useState, type FormEvent } from "react";

import { APP_DISPLAY_NAME } from "../branding";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Spinner } from "../components/ui/spinner";
import { login } from "./authClient";

export function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
      </form>
    </div>
  );
}
