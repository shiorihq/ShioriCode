import { CameraIcon, Loader2Icon, XIcon } from "lucide-react";
import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "convex/react";

import {
  hostedInitiatePasswordChangeMutation,
  hostedUpdateProfileMutation,
} from "../../convex/api";
import { useHostedShioriState } from "../../convex/HostedShioriProvider";
import { useSettings } from "../../hooks/useSettings";
import { getAvatarGradientStyle } from "../../lib/avatar";
import { getPersonalDetailsBlurClass } from "../../lib/personalDetails";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { LoadingText } from "../ui/loading-text";
import { toastManager } from "../ui/toast";
import { HostedBillingPanel } from "../billing/HostedBillingPanel";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./SettingsPanels";

// ---------------------------------------------------------------------------
// Avatar upload helpers
// ---------------------------------------------------------------------------

const MAX_PROFILE_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;

const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/heif",
]);

async function uploadAvatar(file: File): Promise<string> {
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
    throw new Error("Please choose a PNG, JPEG, or WEBP image.");
  }
  if (file.size > MAX_PROFILE_IMAGE_SIZE_BYTES) {
    throw new Error("Profile pictures must be 10MB or smaller.");
  }

  const formData = new FormData();
  formData.append("file", file, file.name);

  const response = await fetch("/api/profile/avatar", { method: "POST", body: formData });
  const json = await response.json().catch(() => ({ success: false, error: response.statusText }));

  if (!response.ok || !json?.success || !json?.data?.url) {
    throw new Error(json?.error || "Failed to upload profile picture.");
  }

  return json.data.url as string;
}

async function deleteAvatarFile(url: string): Promise<void> {
  await fetch("/api/profile/avatar", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// ProfileAvatar
// ---------------------------------------------------------------------------

function ProfileAvatar({
  imageUrl,
  email,
  onUpload,
  onRemove,
  isUploading,
  isRemoving,
}: {
  imageUrl: string | null;
  email: string | null;
  onUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onRemove: () => void;
  isUploading: boolean;
  isRemoving: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const gradientStyle = useMemo(() => getAvatarGradientStyle(email ?? "user"), [email]);
  const busy = isUploading || isRemoving;

  return (
    <div className="relative group shrink-0">
      <div className="size-9 overflow-hidden rounded-md">
        {imageUrl ? (
          <img src={imageUrl} alt="Profile" className="size-full object-cover" />
        ) : (
          <div className="size-full" style={gradientStyle} />
        )}
      </div>

      <button
        type="button"
        className={`absolute inset-0 flex cursor-pointer items-center justify-center rounded-md bg-black/50 transition-opacity ${busy ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
        onClick={() => fileInputRef.current?.click()}
        disabled={busy}
      >
        {busy ? (
          <Loader2Icon className="size-3.5 animate-spin text-white" />
        ) : (
          <CameraIcon className="size-3.5 text-white" />
        )}
      </button>

      {imageUrl && !busy ? (
        <button
          type="button"
          className="absolute -top-1.5 -right-1.5 flex size-4 cursor-pointer items-center justify-center rounded-full border border-border bg-muted text-muted-foreground opacity-0 transition-colors hover:border-destructive/50 hover:text-destructive group-hover:opacity-100"
          onClick={onRemove}
          aria-label="Remove photo"
        >
          <XIcon className="size-2.5" />
        </button>
      ) : null}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/heic,image/heif"
        className="hidden"
        onChange={onUpload}
        disabled={busy}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChangePasswordDialog
// ---------------------------------------------------------------------------

type PasswordStep = "initial" | { email: string };

function ChangePasswordDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { signIn } = useHostedShioriState();
  const blurPersonalData = useSettings().blurPersonalData;
  const initiatePasswordChange = useMutation(hostedInitiatePasswordChangeMutation);

  const [step, setStep] = useState<PasswordStep>("initial");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isPending, setIsPending] = useState(false);

  const reset = useCallback(() => {
    setStep("initial");
    setCode("");
    setNewPassword("");
    setConfirmPassword("");
    setIsPending(false);
  }, []);

  const handleClose = useCallback(() => {
    onOpenChange(false);
    reset();
  }, [onOpenChange, reset]);

  const handleSendCode = useCallback(async () => {
    setIsPending(true);
    try {
      const { email } = await initiatePasswordChange({});
      await signIn("password", { email, flow: "reset" });
      setStep({ email });
      toastManager.add({ type: "success", title: "Reset code sent to your email" });
    } catch {
      toastManager.add({ type: "error", title: "Failed to send reset code" });
    } finally {
      setIsPending(false);
    }
  }, [initiatePasswordChange, signIn]);

  const handleVerify = useCallback(async () => {
    if (typeof step !== "object") return;
    if (newPassword !== confirmPassword) {
      toastManager.add({ type: "error", title: "Passwords do not match" });
      return;
    }
    if (!code.trim() || !newPassword.trim()) return;

    setIsPending(true);
    try {
      await signIn("password", {
        email: step.email,
        code,
        newPassword,
        flow: "reset-verification",
      });
      toastManager.add({ type: "success", title: "Password changed successfully" });
      handleClose();
    } catch (error) {
      const message =
        error instanceof Error &&
        (error.message.includes("InvalidToken") || error.message.includes("ExpiredToken"))
          ? "Invalid or expired code. Please request a new one."
          : "Failed to change password. Please try again.";
      toastManager.add({ type: "error", title: message });
    } finally {
      setIsPending(false);
    }
  }, [step, code, newPassword, confirmPassword, signIn, handleClose]);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Change password</DialogTitle>
          <DialogDescription>
            {step === "initial" ? (
              "We'll send a secure code to your email to verify your identity."
            ) : (
              <>
                Enter the code sent to{" "}
                <span className={getPersonalDetailsBlurClass(blurPersonalData)}>{step.email}</span>
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {step === "initial" ? (
          <DialogFooter variant="bare">
            <Button variant="outline" onClick={handleClose} disabled={isPending}>
              Cancel
            </Button>
            <Button onClick={() => void handleSendCode()} disabled={isPending}>
              {isPending ? <LoadingText>Sending</LoadingText> : "Send reset code"}
            </Button>
          </DialogFooter>
        ) : (
          <>
            <DialogPanel>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="pw-code">Reset code</Label>
                  <Input
                    id="pw-code"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    placeholder="Enter 8-digit code"
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    maxLength={8}
                    spellCheck={false}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pw-new">New password</Label>
                  <Input
                    id="pw-new"
                    type="password"
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                    placeholder="Create a new password"
                    autoComplete="new-password"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pw-confirm">Confirm password</Label>
                  <Input
                    id="pw-confirm"
                    type="password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    placeholder="Confirm your new password"
                    autoComplete="new-password"
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void handleVerify();
                    }}
                  />
                </div>
              </div>
            </DialogPanel>
            <DialogFooter variant="bare">
              <Button variant="outline" onClick={() => reset()} disabled={isPending}>
                Back
              </Button>
              <Button onClick={() => void handleVerify()} disabled={isPending}>
                {isPending ? <LoadingText>Changing</LoadingText> : "Change password"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// AccountPanel
// ---------------------------------------------------------------------------

export function AccountPanel() {
  const { isAuthenticated, isAuthLoading, viewer, signOut } = useHostedShioriState();
  const blurPersonalData = useSettings().blurPersonalData;
  const updateProfile = useMutation(hostedUpdateProfileMutation);

  const [displayName, setDisplayName] = useState("");
  const [isUpdating, setIsUpdating] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [isAvatarUploading, setIsAvatarUploading] = useState(false);
  const [isAvatarRemoving, setIsAvatarRemoving] = useState(false);
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);

  useEffect(() => {
    if (viewer?.name) {
      setDisplayName(viewer.name);
    }
  }, [viewer?.name]);

  const isDirty = useMemo(
    () => displayName.trim() !== (viewer?.name ?? "").trim() && displayName.trim().length > 0,
    [displayName, viewer?.name],
  );

  const handleSave = useCallback(async () => {
    if (!isDirty || isUpdating) return;
    setIsUpdating(true);
    try {
      await updateProfile({ name: displayName.trim() });
      toastManager.add({ type: "success", title: "Profile updated" });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to update profile",
        description: error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setIsUpdating(false);
    }
  }, [isDirty, isUpdating, updateProfile, displayName]);

  const handleRevert = useCallback(() => {
    setDisplayName(viewer?.name ?? "");
  }, [viewer?.name]);

  const handleAvatarUpload = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;

      setIsAvatarUploading(true);
      try {
        const url = await uploadAvatar(file);
        await updateProfile({ image: url });
        toastManager.add({ type: "success", title: "Profile picture updated" });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to update profile picture",
          description: error instanceof Error ? error.message : "Please try again.",
        });
      } finally {
        setIsAvatarUploading(false);
      }
    },
    [updateProfile],
  );

  const handleAvatarRemove = useCallback(async () => {
    if (!viewer?.image) return;
    setIsAvatarRemoving(true);
    try {
      await deleteAvatarFile(viewer.image);
      await updateProfile({ image: "" });
      toastManager.add({ type: "success", title: "Profile picture removed" });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to remove profile picture",
        description: error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setIsAvatarRemoving(false);
    }
  }, [viewer?.image, updateProfile]);

  const handleSignOut = useCallback(async () => {
    if (isSigningOut) return;
    setIsSigningOut(true);
    try {
      await signOut();
    } catch {
      toastManager.add({ type: "error", title: "Failed to sign out" });
    } finally {
      setIsSigningOut(false);
    }
  }, [isSigningOut, signOut]);

  if (isAuthLoading) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Account">
          <div className="px-4 py-8 text-center sm:px-5">
            <p className="text-sm text-muted-foreground">Loading account…</p>
          </div>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  if (!isAuthenticated) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Account">
          <div className="px-4 py-8 text-center sm:px-5">
            <p className="text-sm text-muted-foreground">
              Sign in with your Shiori account to manage your profile.
            </p>
          </div>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return (
    <>
      <SettingsPageContainer>
        <SettingsSection title="Account Information">
          <SettingsRow
            title="Profile picture"
            description="Click to upload a new photo, or hover to remove."
            control={
              <ProfileAvatar
                imageUrl={viewer?.image ?? null}
                email={viewer?.email ?? null}
                onUpload={handleAvatarUpload}
                onRemove={() => void handleAvatarRemove()}
                isUploading={isAvatarUploading}
                isRemoving={isAvatarRemoving}
              />
            }
          />

          <SettingsRow
            title="Display name"
            description="Your public display name."
            control={
              <>
                <Button size="xs" variant="outline" disabled={!isDirty} onClick={handleRevert}>
                  Revert
                </Button>
                <Button
                  size="xs"
                  disabled={!isDirty || isUpdating}
                  onClick={() => void handleSave()}
                >
                  {isUpdating ? <LoadingText>Saving</LoadingText> : "Save"}
                </Button>
              </>
            }
          >
            <Input
              className="mt-2"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && isDirty && !isUpdating) {
                  void handleSave();
                }
              }}
              placeholder="Display name"
              spellCheck={false}
            />
          </SettingsRow>

          <SettingsRow title="Email" description="Your account email address.">
            <Input
              className={`mt-2 bg-muted/50 ${getPersonalDetailsBlurClass(blurPersonalData)}`}
              value={viewer?.email ?? ""}
              disabled
            />
          </SettingsRow>
        </SettingsSection>

        <SettingsSection title="Security">
          <SettingsRow
            title="Password"
            description="Change your password via email verification."
            control={
              <Button size="xs" variant="outline" onClick={() => setPasswordDialogOpen(true)}>
                Change password
              </Button>
            }
          />
        </SettingsSection>

        <SettingsSection title="Subscription">
          <div className="px-4 py-4 sm:px-5">
            <HostedBillingPanel mode="account" />
          </div>
        </SettingsSection>

        <SettingsSection title="Session">
          <SettingsRow
            title="Sign out"
            description="Sign out of your Shiori account on this device."
            control={
              <Button
                size="xs"
                variant="outline"
                disabled={isSigningOut}
                onClick={() => void handleSignOut()}
              >
                {isSigningOut ? <LoadingText>Signing out</LoadingText> : "Sign out"}
              </Button>
            }
          />
        </SettingsSection>
      </SettingsPageContainer>

      <ChangePasswordDialog open={passwordDialogOpen} onOpenChange={setPasswordDialogOpen} />
    </>
  );
}
