import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SidebarProvider } from "../ui/sidebar";
import { ChatHeader } from "./ChatHeader";

vi.mock("./OpenInPicker", () => ({
  OpenInPicker: () => <div data-slot="open-in-picker">OpenInPicker</div>,
}));

describe("ChatHeader", () => {
  it("does not render project actions controls", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <ChatHeader
          activeThreadTitle="Thread title"
          activeProjectPath="/tmp/workspace"
          isGitRepo={true}
          openInCwd="/tmp/workspace"
          keybindings={[]}
          availableEditors={[]}
          terminalToggleShortcutLabel={null}
          browserToggleShortcutLabel={null}
          diffToggleShortcutLabel={null}
          browserOpen={false}
          diffOpen={false}
          isBranchedThread={false}
          parentThread={null}
          missingParentThread={null}
          childThreads={[]}
          onBranchThread={null}
          onNavigateToThread={() => undefined}
          onToggleBrowser={() => undefined}
          onToggleDiff={() => undefined}
        />
      </SidebarProvider>,
    );

    expect(html).toContain("open-in-picker");
    expect(html).toContain("Browser");
    expect(html).toContain("View diff");
    expect(html).not.toContain("Timeline detail level");
    expect(html).not.toContain("Compact");
    expect(html).not.toContain("Git action options");
    expect(html).not.toContain("Initialize Git");
    expect(html).not.toContain("project-scripts-control");
  });

  it("does not render a no-git badge for non-repository projects", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <ChatHeader
          activeThreadTitle="Thread title"
          activeProjectPath="/tmp/workspace"
          isGitRepo={false}
          openInCwd="/tmp/workspace"
          keybindings={[]}
          availableEditors={[]}
          terminalToggleShortcutLabel={null}
          browserToggleShortcutLabel={null}
          diffToggleShortcutLabel={null}
          browserOpen={false}
          diffOpen={false}
          isBranchedThread={false}
          parentThread={null}
          missingParentThread={null}
          childThreads={[]}
          onBranchThread={null}
          onNavigateToThread={() => undefined}
          onToggleBrowser={() => undefined}
          onToggleDiff={() => undefined}
        />
      </SidebarProvider>,
    );

    expect(html).not.toContain("No Git");
  });

  it("does not render the diff control for non-project chats", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <ChatHeader
          activeThreadTitle="Thread title"
          activeProjectPath={undefined}
          isGitRepo={true}
          openInCwd={null}
          keybindings={[]}
          availableEditors={[]}
          terminalToggleShortcutLabel={null}
          browserToggleShortcutLabel={null}
          diffToggleShortcutLabel={null}
          browserOpen={false}
          diffOpen={false}
          isBranchedThread={false}
          parentThread={null}
          missingParentThread={null}
          childThreads={[]}
          onBranchThread={null}
          onNavigateToThread={() => undefined}
          onToggleBrowser={() => undefined}
          onToggleDiff={() => undefined}
        />
      </SidebarProvider>,
    );

    expect(html).toContain("Browser");
    expect(html).not.toContain("View diff");
  });
});
