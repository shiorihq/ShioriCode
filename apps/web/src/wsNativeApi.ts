import {
  type ClientOrchestrationCommand,
  type ContextMenuItem,
  ThreadId,
  type NativeApi,
} from "contracts";

import { showContextMenuFallback } from "./contextMenuFallback";
import { assertThreadLease } from "./lib/threadLease";
import { resetServerStateForTests } from "./rpc/serverState";
import { __resetWsRpcClientForTests, getWsRpcClient } from "./wsRpcClient";

let instance: { api: NativeApi } | null = null;

const THREAD_LEASED_COMMAND_TYPES = new Set<ClientOrchestrationCommand["type"]>([
  "thread.archive",
  "thread.unarchive",
  "thread.delete",
  "thread.meta.update",
  "thread.runtime-mode.set",
  "thread.interaction-mode.set",
  "thread.turn.start",
  "thread.turn.interrupt",
  "thread.approval.respond",
  "thread.user-input.respond",
  "thread.checkpoint.revert",
  "thread.turn.retry",
  "thread.session.ensure",
  "thread.session.stop",
]);

async function dispatchOrchestrationCommand(
  dispatchCommand: NativeApi["orchestration"]["dispatchCommand"],
  command: ClientOrchestrationCommand,
) {
  const threadId =
    "threadId" in command && typeof command.threadId === "string"
      ? ThreadId.makeUnsafe(command.threadId)
      : null;

  if (threadId && THREAD_LEASED_COMMAND_TYPES.has(command.type)) {
    await assertThreadLease(threadId);
  }

  return dispatchCommand(command);
}

export function __resetWsNativeApiForTests() {
  instance = null;
  __resetWsRpcClientForTests();
  resetServerStateForTests();
}

export function createWsNativeApi(): NativeApi {
  if (instance) {
    return instance.api;
  }

  const rpcClient = getWsRpcClient();

  const api: NativeApi = {
    dialogs: {
      pickFolder: async () => {
        if (!window.desktopBridge) return null;
        return window.desktopBridge.pickFolder();
      },
      confirm: async (message) => {
        if (window.desktopBridge) {
          return window.desktopBridge.confirm(message);
        }
        return window.confirm(message);
      },
    },
    terminal: {
      open: (input) => rpcClient.terminal.open(input as never),
      write: (input) => rpcClient.terminal.write(input as never),
      resize: (input) => rpcClient.terminal.resize(input as never),
      clear: (input) => rpcClient.terminal.clear(input as never),
      restart: (input) => rpcClient.terminal.restart(input as never),
      close: (input) => rpcClient.terminal.close(input as never),
      onEvent: (callback) => rpcClient.terminal.onEvent(callback),
    },
    projects: {
      searchEntries: rpcClient.projects.searchEntries,
      writeFile: rpcClient.projects.writeFile,
    },
    shell: {
      openInEditor: (cwd, editor) => rpcClient.shell.openInEditor({ cwd, editor }),
      openExternal: async (url) => {
        if (window.desktopBridge) {
          const opened = await window.desktopBridge.openExternal(url);
          if (!opened) {
            throw new Error("Unable to open link.");
          }
          return;
        }

        window.open(url, "_blank", "noopener,noreferrer");
      },
    },
    git: {
      status: rpcClient.git.status,
      listBranches: rpcClient.git.listBranches,
      createWorktree: rpcClient.git.createWorktree,
      removeWorktree: rpcClient.git.removeWorktree,
      createBranch: rpcClient.git.createBranch,
      checkout: rpcClient.git.checkout,
      init: rpcClient.git.init,
      resolvePullRequest: rpcClient.git.resolvePullRequest,
      preparePullRequestThread: rpcClient.git.preparePullRequestThread,
      listOpenPullRequests: rpcClient.git.listOpenPullRequests,
      getPullRequestDiff: rpcClient.git.getPullRequestDiff,
      summarizePullRequest: rpcClient.git.summarizePullRequest,
      getPullRequestConversation: rpcClient.git.getPullRequestConversation,
    },
    contextMenu: {
      show: async <T extends string>(
        items: readonly ContextMenuItem<T>[],
        position?: { x: number; y: number },
      ): Promise<T | null> => {
        if (window.desktopBridge) {
          return window.desktopBridge.showContextMenu(items, position) as Promise<T | null>;
        }
        return showContextMenuFallback(items, position);
      },
    },
    server: {
      getConfig: rpcClient.server.getConfig,
      refreshProviders: rpcClient.server.refreshProviders,
      upsertKeybinding: rpcClient.server.upsertKeybinding,
      getSettings: rpcClient.server.getSettings,
      updateSettings: rpcClient.server.updateSettings,
      listMcpServers: rpcClient.server.listMcpServers,
      authenticateMcpServer: (input) =>
        rpcClient.server.authenticateMcpServer(input).then(() => undefined),
      removeMcpServer: (input) => rpcClient.server.removeMcpServer(input).then(() => undefined),
      listSkills: rpcClient.server.listSkills,
      removeSkill: (input) => rpcClient.server.removeSkill(input).then(() => undefined),
      setShioriAuthToken: (token) => rpcClient.server.setShioriAuthToken(token),
      getProviderUsage: (provider) => rpcClient.server.getProviderUsage({ provider }),
      getHostedBillingSnapshot: () => rpcClient.server.getHostedBillingSnapshot(),
      createHostedBillingCheckout: (input) => rpcClient.server.createHostedBillingCheckout(input),
      createHostedBillingPortal: (flow) => rpcClient.server.createHostedBillingPortal({ flow }),
    },
    orchestration: {
      getSnapshot: rpcClient.orchestration.getSnapshot,
      dispatchCommand: (command) =>
        dispatchOrchestrationCommand(
          rpcClient.orchestration.dispatchCommand,
          command as ClientOrchestrationCommand,
        ),
      getTurnDiff: rpcClient.orchestration.getTurnDiff,
      getFullThreadDiff: rpcClient.orchestration.getFullThreadDiff,
      getSubagentDetail: rpcClient.orchestration.getSubagentDetail,
      replayEvents: (fromSequenceExclusive) =>
        rpcClient.orchestration
          .replayEvents({ fromSequenceExclusive })
          .then((events) => [...events]),
      onDomainEvent: (callback) => rpcClient.orchestration.onDomainEvent(callback),
    },
    onboarding: {
      getState: rpcClient.onboarding.getState,
      completeStep: (input) => rpcClient.onboarding.completeStep(input),
      reset: rpcClient.onboarding.reset,
    },
    telemetry: {
      capture: (input) => rpcClient.telemetry.capture(input),
      log: (input) => rpcClient.telemetry.log(input),
    },
  };

  instance = { api };
  return api;
}
