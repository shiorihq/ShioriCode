import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createComputerUsePermissionRecheckSchedule,
  isComputerUsePermissionGranted,
  runComputerUsePermissionFlow,
} from "./computerUsePermissionFlow";

afterEach(() => {
  vi.useRealTimers();
});

describe("runComputerUsePermissionFlow", () => {
  it("returns after a successful direct macOS permission request", async () => {
    const requestPermission = vi.fn(async () => ({
      ok: true,
      kind: "accessibility" as const,
      message: "Accessibility permission is enabled.",
    }));
    const showPermissionGuide = vi.fn();

    await expect(
      runComputerUsePermissionFlow("accessibility", {
        requestPermission,
        showPermissionGuide,
      }),
    ).resolves.toEqual({
      ok: true,
      kind: "accessibility",
      message: "Accessibility permission is enabled.",
    });
    expect(showPermissionGuide).not.toHaveBeenCalled();
  });

  it("opens the permiso guide when the direct request is not enough", async () => {
    const requestPermission = vi.fn(async () => ({
      ok: false,
      kind: "screen-recording" as const,
      message: "Screen Recording still needs to be enabled in System Settings.",
    }));
    const showPermissionGuide = vi.fn(async () => ({
      ok: true,
      kind: "screen-recording" as const,
      message: "Opened the macOS permission guide.",
    }));

    await expect(
      runComputerUsePermissionFlow("screen-recording", {
        requestPermission,
        showPermissionGuide,
      }),
    ).resolves.toEqual({
      ok: true,
      kind: "screen-recording",
      message: "Opened the macOS permission guide.",
    });
    expect(showPermissionGuide).toHaveBeenCalledWith({ kind: "screen-recording" });
  });

  it("reports unavailable when no permission mechanism exists", async () => {
    await expect(runComputerUsePermissionFlow("accessibility", {})).resolves.toEqual({
      ok: false,
      kind: "accessibility",
      message: "Computer Use permission guides are unavailable in this browser.",
    });
  });

  it("detects granted permission snapshots", () => {
    expect(
      isComputerUsePermissionGranted(
        {
          platform: "darwin",
          supported: true,
          helperAvailable: true,
          helperPath: "/tmp/ShioriComputerUseHelper",
          checkedAt: "2026-06-04T00:00:00.000Z",
          message: null,
          permissions: [
            {
              kind: "accessibility",
              label: "Accessibility",
              state: "granted",
              detail: "Ready.",
            },
          ],
        },
        "accessibility",
      ),
    ).toBe(true);
    expect(isComputerUsePermissionGranted(undefined, "screen-recording")).toBe(false);
  });

  it("rechecks permissions until the requested kind is granted", async () => {
    vi.useFakeTimers();
    const refresh = vi
      .fn()
      .mockResolvedValueOnce({
        platform: "darwin",
        supported: true,
        helperAvailable: true,
        helperPath: "/tmp/ShioriComputerUseHelper",
        checkedAt: "2026-06-04T00:00:00.000Z",
        message: null,
        permissions: [
          {
            kind: "screen-recording",
            label: "Screen Recording",
            state: "denied",
            detail: "Needs permission.",
          },
        ],
      })
      .mockResolvedValueOnce({
        platform: "darwin",
        supported: true,
        helperAvailable: true,
        helperPath: "/tmp/ShioriComputerUseHelper",
        checkedAt: "2026-06-04T00:00:03.000Z",
        message: null,
        permissions: [
          {
            kind: "screen-recording",
            label: "Screen Recording",
            state: "granted",
            detail: "Ready.",
          },
        ],
      });
    const onGranted = vi.fn();

    createComputerUsePermissionRecheckSchedule({
      kind: "screen-recording",
      delaysMs: [100, 200, 300],
      refresh,
      onGranted,
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(onGranted).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(onGranted).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("can cancel scheduled permission rechecks", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn();

    const cancel = createComputerUsePermissionRecheckSchedule({
      kind: "accessibility",
      delaysMs: [100, 200],
      refresh,
    });

    cancel();
    await vi.advanceTimersByTimeAsync(250);

    expect(refresh).not.toHaveBeenCalled();
  });
});
