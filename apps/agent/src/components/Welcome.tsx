import { Box, Text } from "ink";
import React from "react";

import { version } from "../../package.json" with { type: "json" };
import { palette } from "../theme";

export function Welcome({ cwd }: { readonly cwd: string }) {
  return (
    <Box flexDirection="column" paddingX={1} paddingY={0} marginBottom={1}>
      <Box>
        <Text color={palette.accent} bold>
          ✻{" "}
        </Text>
        <Text bold color={palette.accentBright}>
          shiori
        </Text>
        <Text dimColor> agent · v{version}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          <Text color={palette.accent}>›</Text> type a message, or{" "}
          <Text color={palette.accent}>/</Text> for commands
        </Text>
        <Text dimColor>
          <Text color={palette.accent}>›</Text> cwd: {cwd}
        </Text>
      </Box>
    </Box>
  );
}
