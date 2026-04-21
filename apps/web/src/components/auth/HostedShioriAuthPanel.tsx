import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { LoadingText } from "../ui/loading-text";
import { useHostedShioriState } from "../../convex/HostedShioriProvider";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSettings } from "../../hooks/useSettings";
import { getPersonalDetailsBlurClass, shouldBlurEmailMention } from "../../lib/personalDetails";
import { isElectron } from "../../env";

import {
  signInWithHostedOAuthDesktop,
  signInWithHostedPasswordDesktop,
  toHostedShioriAuthErrorMessage,
  withHostedShioriRedirect,
} from "./hostedShioriAuth";

export type PasswordStage = "signIn" | "signUp" | "verifyEmail" | "forgot" | "reset";
type OAuthProvider = "github" | "google" | "apple";

const MIN_PASSWORD_LENGTH = 8;
const URL_STAGE_PARAM = "auth";
const URL_STAGE_VALUES = new Set<PasswordStage>([
  "signIn",
  "signUp",
  "verifyEmail",
  "forgot",
  "reset",
]);

function readStageFromUrl(): PasswordStage | null {
  if (typeof window === "undefined") return null;
  const value = new URL(window.location.href).searchParams.get(URL_STAGE_PARAM);
  return value && URL_STAGE_VALUES.has(value as PasswordStage) ? (value as PasswordStage) : null;
}

function writeStageToUrl(stage: PasswordStage) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (stage === "signIn") {
    url.searchParams.delete(URL_STAGE_PARAM);
  } else {
    url.searchParams.set(URL_STAGE_PARAM, stage);
  }
  const next = url.pathname + (url.search ? url.search : "") + url.hash;
  window.history.replaceState(window.history.state, "", next);
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}

function AppleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.32 2.32-2.14 4.52-3.74 4.25z" />
    </svg>
  );
}

export function HostedShioriAuthPanel(props?: {
  disabled?: boolean;
  className?: string;
  heading?: string;
  description?: string;
  compact?: boolean;
  syncStageWithUrl?: boolean;
  onStageChange?: (stage: PasswordStage) => void;
}) {
  const { isAuthenticated, isAuthLoading, viewer, signIn, signOut } = useHostedShioriState();
  const blurPersonalData = useSettings().blurPersonalData;
  const syncStageWithUrl = props?.syncStageWithUrl === true;
  const onStageChangeProp = props?.onStageChange;
  const [stage, setStageInner] = useState<PasswordStage>(
    () => (syncStageWithUrl ? readStageFromUrl() : null) ?? "signIn",
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [verificationEmail, setVerificationEmail] = useState("");
  const [verificationPassword, setVerificationPassword] = useState("");
  const [resetEmail, setResetEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const setStage = useCallback(
    (next: PasswordStage) => {
      setStageInner(next);
      if (syncStageWithUrl) writeStageToUrl(next);
      onStageChangeProp?.(next);
    },
    [syncStageWithUrl, onStageChangeProp],
  );

  useEffect(() => {
    onStageChangeProp?.(stage);
    // Intentionally only on mount so the parent can pick up the URL-initialized stage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!syncStageWithUrl) return;
    const handler = () => {
      const nextStage = readStageFromUrl() ?? "signIn";
      setStageInner(nextStage);
      onStageChangeProp?.(nextStage);
    };
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, [syncStageWithUrl, onStageChangeProp]);

  const disabled = props?.disabled === true || pendingAction !== null;
  const heading = props?.heading ?? "Sign in";
  const description =
    props?.description ?? "Use your existing Shiori authentication method to continue.";

  const submitLabel = useMemo(() => {
    switch (stage) {
      case "signIn":
        return "Sign in with password";
      case "signUp":
        return "Create account";
      case "verifyEmail":
        return "Verify email";
      case "forgot":
        return "Send reset code";
      case "reset":
        return "Reset password";
    }
  }, [stage]);

  const pendingPasswordLabel = useMemo(() => {
    switch (stage) {
      case "signIn":
        return "Logging in";
      case "signUp":
        return "Creating account";
      case "verifyEmail":
        return "Verifying";
      case "forgot":
        return "Sending reset code";
      case "reset":
        return "Resetting password";
    }
  }, [stage]);

  const runAsync = useCallback(
    async (action: string, fn: () => Promise<void>) => {
      if (disabled) {
        return;
      }
      setPendingAction(action);
      setError(null);
      try {
        await fn();
      } catch (nextError) {
        setError(toHostedShioriAuthErrorMessage(nextError));
      } finally {
        setPendingAction(null);
      }
    },
    [disabled],
  );

  const handleOAuthSignIn = useCallback(
    (provider: OAuthProvider) => {
      void runAsync(`oauth:${provider}`, async () => {
        if (isElectron) {
          await signInWithHostedOAuthDesktop({
            provider,
            currentLocationHref: typeof window === "undefined" ? undefined : window.location.href,
          });
          return;
        }

        await signIn(
          provider,
          withHostedShioriRedirect(
            {},
            typeof window === "undefined" ? undefined : window.location.href,
          ),
        );
      });
    },
    [runAsync, signIn],
  );

  const handlePasswordSubmit = useCallback(() => {
    if (stage === "signUp") {
      if (password.length < MIN_PASSWORD_LENGTH) {
        setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
        return;
      }
      if (password !== confirmPassword) {
        setError("Passwords do not match.");
        return;
      }
    }

    void runAsync(`password:${stage}`, async () => {
      if (stage === "signIn" || stage === "signUp") {
        const result = isElectron
          ? await signInWithHostedPasswordDesktop({
              email,
              password,
              flow: stage,
            })
          : await signIn("password", {
              ...withHostedShioriRedirect(
                {
                  email,
                  password,
                  flow: stage,
                },
                typeof window === "undefined" ? undefined : window.location.href,
              ),
            });
        if (!result?.signingIn) {
          setVerificationEmail(email);
          setVerificationPassword(password);
          setCode("");
          setNotice("Check your email for a verification code.");
          setStage("verifyEmail");
        }
        return;
      }

      if (stage === "verifyEmail") {
        const result = isElectron
          ? await signInWithHostedPasswordDesktop({
              email: verificationEmail,
              code,
              flow: "email-verification",
            })
          : await signIn("password", {
              ...withHostedShioriRedirect(
                {
                  email: verificationEmail,
                  code,
                  flow: "email-verification",
                },
                typeof window === "undefined" ? undefined : window.location.href,
              ),
            });
        if (!result?.signingIn) {
          throw new Error("Invalid or expired verification code. Please try again.");
        }
        return;
      }

      if (stage === "forgot") {
        if (isElectron) {
          await signInWithHostedPasswordDesktop({
            email,
            flow: "reset",
          });
        } else {
          await signIn("password", {
            email,
            flow: "reset",
          });
        }
        setResetEmail(email);
        setCode("");
        setNewPassword("");
        setNotice("Password reset code sent.");
        setStage("reset");
        return;
      }

      if (isElectron) {
        await signInWithHostedPasswordDesktop({
          email: resetEmail,
          code,
          newPassword,
          flow: "reset-verification",
        });
      } else {
        await signIn("password", {
          email: resetEmail,
          code,
          newPassword,
          flow: "reset-verification",
        });
      }
      setPassword("");
      setNewPassword("");
      setCode("");
      setNotice("Password updated. Sign in with your new password.");
      setStage("signIn");
      setEmail(resetEmail);
      setConfirmPassword("");
    });
  }, [
    code,
    confirmPassword,
    email,
    newPassword,
    password,
    resetEmail,
    runAsync,
    setStage,
    signIn,
    stage,
    verificationEmail,
  ]);

  const handleResendVerification = useCallback(() => {
    void runAsync("password:resend-verification", async () => {
      const result = isElectron
        ? await signInWithHostedPasswordDesktop({
            email: verificationEmail,
            password: verificationPassword,
            flow: "signIn",
          })
        : await signIn("password", {
            ...withHostedShioriRedirect(
              {
                email: verificationEmail,
                password: verificationPassword,
                flow: "signIn",
              },
              typeof window === "undefined" ? undefined : window.location.href,
            ),
          });
      if (!result?.signingIn) {
        setNotice("Verification code resent.");
      }
    });
  }, [runAsync, signIn, verificationEmail, verificationPassword]);

  const handleSignOut = useCallback(() => {
    void runAsync("signOut", async () => {
      await signOut();
      setNotice(null);
      setError(null);
      setStage("signIn");
    });
  }, [runAsync, setStage, signOut]);

  const showHeader = Boolean(heading || description);
  const signedInIdentity = viewer?.name ?? viewer?.email ?? "Signed in";
  const signedInIdentityBlurClass = getPersonalDetailsBlurClass(
    shouldBlurEmailMention({
      blurPersonalData,
      email: viewer?.email,
      text: signedInIdentity,
    }),
  );
  const emailBlurClass = getPersonalDetailsBlurClass(blurPersonalData);

  return (
    <div className={props?.className}>
      {showHeader ? (
        <div className="space-y-1">
          {heading ? <h2 className="text-base font-semibold text-foreground">{heading}</h2> : null}
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
      ) : null}

      <div className={`space-y-4${showHeader ? " mt-4" : ""}`}>
        {isAuthenticated ? (
          <div className="space-y-3">
            <div className="rounded-xl border border-border/70 bg-background/60 p-3">
              <div className={`text-sm font-medium text-foreground ${signedInIdentityBlurClass}`}>
                {signedInIdentity}
              </div>
              {viewer?.email ? (
                <div className={`text-xs text-muted-foreground ${emailBlurClass}`}>
                  {viewer.email}
                </div>
              ) : null}
            </div>
            <Button
              size={props?.compact ? "sm" : "default"}
              variant="outline"
              disabled={disabled}
              onClick={handleSignOut}
            >
              {pendingAction === "signOut" ? <LoadingText>Signing out</LoadingText> : "Sign out"}
            </Button>
          </div>
        ) : (
          <>
            <div className="grid gap-2 sm:grid-cols-3">
              <Button
                size={props?.compact ? "sm" : "default"}
                variant="outline"
                disabled={disabled || isAuthLoading}
                onClick={() => handleOAuthSignIn("github")}
              >
                {pendingAction === "oauth:github" ? (
                  <LoadingText>Redirecting</LoadingText>
                ) : (
                  <>
                    <GitHubIcon />
                    GitHub
                  </>
                )}
              </Button>
              <Button
                size={props?.compact ? "sm" : "default"}
                variant="outline"
                disabled={disabled || isAuthLoading}
                onClick={() => handleOAuthSignIn("google")}
              >
                {pendingAction === "oauth:google" ? (
                  <LoadingText>Redirecting</LoadingText>
                ) : (
                  <>
                    <GoogleIcon />
                    Google
                  </>
                )}
              </Button>
              <Button
                size={props?.compact ? "sm" : "default"}
                variant="outline"
                disabled={disabled || isAuthLoading}
                onClick={() => handleOAuthSignIn("apple")}
              >
                {pendingAction === "oauth:apple" ? (
                  <LoadingText>Redirecting</LoadingText>
                ) : (
                  <>
                    <AppleIcon />
                    Apple
                  </>
                )}
              </Button>
            </div>

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t border-border/70" />
              </div>
              <div className="relative flex justify-center text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                <span className="bg-card px-2">or</span>
              </div>
            </div>

            <form
              className="space-y-3"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                if (!form.checkValidity()) {
                  const firstInvalid = form.querySelector<HTMLElement>(":invalid");
                  firstInvalid?.focus();
                  form.reportValidity();
                  return;
                }
                setError(null);
                handlePasswordSubmit();
              }}
            >
              {(stage === "signIn" || stage === "signUp" || stage === "forgot") && (
                <div className="space-y-2">
                  <Label htmlFor="hosted-auth-email">Email</Label>
                  <Input
                    id="hosted-auth-email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    type="email"
                    autoComplete="email"
                    spellCheck={false}
                    required
                    disabled={disabled}
                  />
                </div>
              )}

              {(stage === "signIn" || stage === "signUp") && (
                <div className="space-y-2">
                  <Label htmlFor="hosted-auth-password">Password</Label>
                  <Input
                    id="hosted-auth-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    type="password"
                    autoComplete={stage === "signIn" ? "current-password" : "new-password"}
                    required
                    minLength={stage === "signUp" ? MIN_PASSWORD_LENGTH : undefined}
                    disabled={disabled}
                    aria-describedby={stage === "signUp" ? "hosted-auth-password-hint" : undefined}
                  />
                  {stage === "signUp" ? (
                    <p id="hosted-auth-password-hint" className="text-[11px] text-muted-foreground">
                      At least {MIN_PASSWORD_LENGTH} characters.
                    </p>
                  ) : null}
                </div>
              )}

              {stage === "signUp" && (
                <div className="space-y-2">
                  <Label htmlFor="hosted-auth-confirm-password">Confirm password</Label>
                  <Input
                    id="hosted-auth-confirm-password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={MIN_PASSWORD_LENGTH}
                    disabled={disabled}
                  />
                </div>
              )}

              {stage === "verifyEmail" && (
                <>
                  <p className="text-xs text-muted-foreground">
                    Enter the verification code sent to{" "}
                    <span className={emailBlurClass}>{verificationEmail}</span>.
                  </p>
                  <div className="space-y-2">
                    <Label htmlFor="hosted-auth-code">Verification code</Label>
                    <Input
                      id="hosted-auth-code"
                      value={code}
                      onChange={(event) => setCode(event.target.value)}
                      autoComplete="one-time-code"
                      required
                      disabled={disabled}
                    />
                  </div>
                </>
              )}

              {stage === "reset" && (
                <>
                  <p className="text-xs text-muted-foreground">
                    Enter the reset code sent to{" "}
                    <span className={emailBlurClass}>{resetEmail}</span>.
                  </p>
                  <div className="space-y-2">
                    <Label htmlFor="hosted-reset-code">Reset code</Label>
                    <Input
                      id="hosted-reset-code"
                      value={code}
                      onChange={(event) => setCode(event.target.value)}
                      autoComplete="one-time-code"
                      required
                      disabled={disabled}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="hosted-reset-password">New password</Label>
                    <Input
                      id="hosted-reset-password"
                      value={newPassword}
                      onChange={(event) => setNewPassword(event.target.value)}
                      type="password"
                      autoComplete="new-password"
                      required
                      disabled={disabled}
                    />
                  </div>
                </>
              )}

              {notice ? (
                <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
                  {notice}
                </p>
              ) : null}
              {error ? (
                <div
                  role="alert"
                  aria-live="assertive"
                  className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  <svg
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    className="mt-0.5 h-4 w-4 flex-shrink-0"
                    aria-hidden="true"
                  >
                    <path
                      fillRule="evenodd"
                      d="M10 2a8 8 0 100 16 8 8 0 000-16zm0 4a1 1 0 011 1v4a1 1 0 11-2 0V7a1 1 0 011-1zm0 8.5a1 1 0 100 2 1 1 0 000-2z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <span className="leading-snug">{error}</span>
                </div>
              ) : null}

              <Button
                className="w-full"
                size={props?.compact ? "sm" : "default"}
                type="submit"
                disabled={disabled || isAuthLoading}
              >
                {pendingAction?.startsWith("password:") ? (
                  <LoadingText>{pendingPasswordLabel}</LoadingText>
                ) : (
                  submitLabel
                )}
              </Button>

              <div className="flex items-center justify-center gap-3 text-sm">
                {stage === "signIn" && (
                  <>
                    <button
                      type="button"
                      className="cursor-pointer text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-64"
                      disabled={disabled}
                      onClick={() => {
                        setStage("signUp");
                        setError(null);
                        setNotice(null);
                      }}
                    >
                      Create account
                    </button>
                    <span className="text-border">|</span>
                    <button
                      type="button"
                      className="cursor-pointer text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-64"
                      disabled={disabled}
                      onClick={() => {
                        setStage("forgot");
                        setError(null);
                        setNotice(null);
                      }}
                    >
                      Forgot password?
                    </button>
                  </>
                )}

                {stage === "signUp" && (
                  <button
                    type="button"
                    className="cursor-pointer text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-64"
                    disabled={disabled}
                    onClick={() => {
                      setStage("signIn");
                      setError(null);
                      setNotice(null);
                    }}
                  >
                    Already have an account?
                  </button>
                )}

                {stage === "verifyEmail" && (
                  <>
                    <button
                      type="button"
                      className="cursor-pointer text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-64"
                      disabled={disabled}
                      onClick={handleResendVerification}
                    >
                      Resend code
                    </button>
                    <span className="text-border">|</span>
                    <button
                      type="button"
                      className="cursor-pointer text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-64"
                      disabled={disabled}
                      onClick={() => {
                        setStage("signIn");
                        setCode("");
                        setError(null);
                        setNotice(null);
                      }}
                    >
                      Cancel
                    </button>
                  </>
                )}

                {(stage === "forgot" || stage === "reset") && (
                  <button
                    type="button"
                    className="cursor-pointer text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-64"
                    disabled={disabled}
                    onClick={() => {
                      setStage("signIn");
                      setCode("");
                      setNewPassword("");
                      setError(null);
                      setNotice(null);
                    }}
                  >
                    Back to sign in
                  </button>
                )}
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
