import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import {
  currentServicePlatform,
  findInstalledServiceLayout,
  serviceLayout,
  type ServiceLayout,
} from "./serviceManager";

const execFile = promisify(execFileCallback);

interface ProviderProbe {
  readonly name: string;
  readonly binary: string;
  readonly installHint: string;
  readonly authHint: string;
  readonly credentialPaths: readonly string[];
}

const PROVIDERS: readonly ProviderProbe[] = [
  {
    name: "Codex",
    binary: "codex",
    installHint: "npm install -g @openai/codex",
    authHint: "codex login --device-auth",
    credentialPaths: [".codex/auth.json"],
  },
  {
    name: "Claude Code",
    binary: "claude",
    installHint: "npm install -g @anthropic-ai/claude-code",
    authHint: "claude login",
    credentialPaths: [".claude/.credentials.json", ".claude.json"],
  },
  {
    name: "Kimi Code",
    binary: "kimi",
    installHint: "Install Kimi Code from its official CLI instructions",
    authHint: "kimi login",
    credentialPaths: [".kimi"],
  },
];

async function binaryVersion(
  binary: string,
  home: string,
  configuredPath: string,
): Promise<string | null> {
  try {
    const result = await execFile(binary, ["--version"], {
      env: { ...process.env, HOME: home, PATH: configuredPath },
      timeout: 5_000,
      windowsHide: true,
    });
    return (result.stdout || result.stderr).trim().split("\n")[0] || "installed";
  } catch {
    return null;
  }
}

function hasCredentials(home: string, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => fs.existsSync(path.join(home, candidate)));
}

function serviceAccountCommand(command: string, layout: ServiceLayout): string {
  if (layout.accountMode === "current") return command;
  if (layout.platform === "linux") {
    return `sudo -u ${layout.account} -H ${command}`;
  }
  if (layout.platform === "darwin") {
    return `sudo -u ${layout.account} -H env PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin ${command}`;
  }
  return `${command} (run it for the ${layout.account} service account)`;
}

export async function providerDoctor(): Promise<string> {
  const layout = (await findInstalledServiceLayout()) ?? serviceLayout(currentServicePlatform());
  const lines = [`Service account: ${layout.account}`, `Service home: ${layout.homeDir}`, ""];
  for (const provider of PROVIDERS) {
    const version = await binaryVersion(provider.binary, layout.homeDir, layout.servicePath);
    if (!version) {
      lines.push(`✗ ${provider.name}: not found in the service PATH`);
      lines.push(`  Install: ${provider.installHint}`);
      continue;
    }
    const authenticated = hasCredentials(layout.homeDir, provider.credentialPaths);
    lines.push(`✓ ${provider.name}: ${version}`);
    lines.push(
      authenticated
        ? "  Credentials detected in the service home"
        : `  Sign in: ${serviceAccountCommand(provider.authHint, layout)}`,
    );
  }
  lines.push("", "ShioriCode never installs provider CLIs or signs into them without you.");
  return lines.join("\n");
}
