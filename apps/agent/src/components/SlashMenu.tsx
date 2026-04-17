import { Box, Text } from "ink";
import React from "react";

import { palette } from "../theme";

export interface SlashCommand {
  readonly name: string;
  readonly description: string;
  readonly aliases?: ReadonlyArray<string>;
}

export const SLASH_COMMANDS: ReadonlyArray<SlashCommand> = [
  { name: "/help", description: "Show help and keyboard shortcuts" },
  { name: "/new", description: "Start a new thread in the current project" },
  { name: "/threads", description: "Open the thread switcher" },
  { name: "/model", description: "Open the model & provider settings" },
  { name: "/interrupt", description: "Interrupt the current turn" },
  { name: "/archive", description: "Archive the current thread" },
  { name: "/clear", description: "Clear the composer" },
  { name: "/exit", description: "Quit shiori", aliases: ["/quit"] },
];

export function matchCommands(input: string): ReadonlyArray<SlashCommand> {
  const query = input.toLowerCase();
  return SLASH_COMMANDS.filter((command) => {
    if (command.name.startsWith(query)) {
      return true;
    }
    return command.aliases?.some((alias) => alias.startsWith(query)) ?? false;
  });
}

export function SlashMenu({
  query,
  selectedIndex,
}: {
  readonly query: string;
  readonly selectedIndex: number;
}) {
  const matches = matchCommands(query);
  if (matches.length === 0) {
    return null;
  }
  return (
    <Box flexDirection="column" paddingX={1} marginBottom={0}>
      {matches.map((command, index) => {
        const selected = index === selectedIndex;
        return (
          <Box key={command.name}>
            <Text color={selected ? palette.accentBright : palette.accent}>
              {selected ? "›" : " "}{" "}
            </Text>
            <Text color={selected ? palette.accentBright : palette.accent} bold={selected}>
              {command.name.padEnd(12)}
            </Text>
            <Text dimColor>{command.description}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
