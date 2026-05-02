import { Box, Text } from "ink";
import React from "react";

import { version } from "../../package.json" with { type: "json" };
import { palette } from "../theme";

function compactPath(path: string, maxLength: number): string {
  if (path.length <= maxLength) return path;

  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 2) return `…${path.slice(-(maxLength - 1))}`;

  const tail = parts.slice(-2).join("/");
  const suffix = `…/${tail}`;
  if (suffix.length <= maxLength) return suffix;

  return `…${path.slice(-(maxLength - 1))}`;
}

function displayPath(path: string): string {
  const home = process.env.HOME;
  if (home && path === home) return "~";
  if (home && path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  return path;
}

export function Welcome({ columns, cwd }: { readonly columns: number; readonly cwd: string }) {
  const availablePathWidth = Math.max(24, columns - 18);
  const displayCwd = compactPath(displayPath(cwd), availablePathWidth);

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      <Box>
        <Text color={palette.accentDim}>╭─ </Text>
        <Text color={palette.accentBright} bold>
          shiori
        </Text>
        <Text color={palette.accent}> agent</Text>
        <Text dimColor> v{version}</Text>
        <Text color={palette.accentDim}> ─╮</Text>
      </Box>
      <Box>
        <Text color={palette.accentDim}>│ </Text>
        <Text dimColor>workspace </Text>
        <Text>{displayCwd}</Text>
      </Box>
      <Box>
        <Text color={palette.accentDim}>╰─ </Text>
        <Text dimColor>
          <Text color={palette.accent}>/</Text> commands ·{" "}
          <Text color={palette.accent}>ctrl+p</Text> threads ·{" "}
          <Text color={palette.accent}>ctrl+n</Text> new
        </Text>
      </Box>
    </Box>
  );
}
