# Google Antigravity SDK for TypeScript

This repository is a TypeScript port of the Python
[`google-antigravity`](https://github.com/google-antigravity/antigravity-sdk-python)
SDK.

The Google Antigravity SDK is for building AI agents powered by Antigravity and
Gemini. It provides a secure, stateful infrastructure layer that abstracts the
agentic loop, letting you focus on what your agent does rather than how it runs.

## Installation

Install the package in an application:

```bash
bun add google-antigravity
```

Install this repository's development dependencies:

```bash
bun install
```

Real agent execution requires `GEMINI_API_KEY` and a `localharness` runtime
binary:

```bash
export GEMINI_API_KEY="your_api_key_here"
```

The Python SDK ships a compiled `localharness` runtime in platform-specific
wheels. This TypeScript package exposes a local runtime strategy boundary and
discovers a runtime from `LocalAgentConfig.runtimePath`,
`ANTIGRAVITY_HARNESS_PATH`, `ANTIGRAVITY_LOCALHARNESS_PATH`,
`bin/localharness` inside the package, or `localharness` on `PATH`.

## Quickstart

```ts
import { Agent, LocalAgentConfig } from "google-antigravity";

await using agent = await Agent.start(
  new LocalAgentConfig({
    systemInstructions: "You are an expert assistant for codebase navigation.",
  }),
);

const response = await agent.chat("What files are in the current directory?");
console.log(await response.text());
```

Run a local example with Bun:

```bash
bun examples/getting_started/hello_world.ts
```

## Concepts

### Simple Agent

`Agent` is the high-level entry point. It manages runtime startup, tool wiring,
hook registration, policies, triggers, MCP servers, and cleanup.

```ts
import { Agent, LocalAgentConfig } from "google-antigravity";

const agent = await Agent.start(new LocalAgentConfig());
try {
  const response = await agent.chat("Say hello in one sentence.");
  console.log(await response.text());
} finally {
  await agent.stop();
}
```

For callback-style cleanup, use `Agent.using()`:

```ts
await Agent.using(new LocalAgentConfig(), async (agent) => {
  const response = await agent.chat("Say hello in one sentence.");
  console.log(await response.text());
});
```

### Streaming Responses

`Agent.chat()` returns a `ChatResponse`. Iterate over it directly to stream text
tokens:

```ts
const response = await agent.chat("Write a short poem about space.");
for await (const token of response) {
  process.stdout.write(token);
}
console.log();
```

For advanced UI surfaces, stream thoughts and tool calls:

```ts
for await (const thought of response.thoughts) {
  showThinkingBubble(thought);
}

for await (const call of response.toolCalls) {
  showExecutingSpinner(String(call.name));
}
```

### Advanced Conversation Control

Use `Conversation` directly when you need explicit send/receive control or
step-level history:

```ts
await agent.conversation.send("Tell me more.");

for await (const step of agent.conversation.receiveSteps()) {
  if (step.isCompleteResponse) {
    console.log(step.content);
  }
}

console.log(agent.conversation.history.length);
console.log(agent.conversation.turnCount);
console.log(agent.conversation.lastResponse);
```

### Multimodal Input

Pass rich content objects alongside text. `fromFile()` resolves a supported file
type automatically, while the media constructors work well for in-memory bytes.

```ts
import { Image, fromFile } from "google-antigravity";

const chart = Image.fromFile("chart.png", "Architecture diagram");
const spec = fromFile("spec.pdf");

const response = await agent.chat(["Compare this chart with the specification.", chart, spec]);
console.log(await response.text());
```

### Custom Tools

Register TypeScript functions as tools the agent can call:

```ts
function getWeather(city: string): string {
  return `It is sunny in ${city}.`;
}

const agent = await Agent.start(
  new LocalAgentConfig({
    tools: [getWeather],
  }),
);
```

Tools can opt into `ToolContext` for conversation-aware state and trigger-style
messages:

```ts
import { ToolContext } from "google-antigravity";

function rememberFact(key: string, value: string, ctx: ToolContext): string {
  ctx.setState(key, value);
  return "Stored.";
}
```

### MCP Integration

Connect external MCP servers and expose their tools to the agent:

```ts
import { Agent, LocalAgentConfig, McpStdioServer, policy } from "google-antigravity";

const server = new McpStdioServer({
  name: "math",
  command: "node",
  args: ["./mcp-server.js"],
});

const agent = await Agent.start(
  new LocalAgentConfig({
    mcpServers: [server],
    policies: [policy.allowAll()],
  }),
);
```

### Hooks and Policies

Policies control tool access declaratively:

```ts
import { BuiltinTools, LocalAgentConfig, ToolCall, policy } from "google-antigravity";

async function approve(toolCall: ToolCall): Promise<boolean> {
  console.log(`Approve ${toolCall.name}?`);
  return false;
}

const config = new LocalAgentConfig({
  policies: [
    policy.denyAll(),
    policy.allow(BuiltinTools.VIEW_FILE),
    policy.askUser(BuiltinTools.RUN_COMMAND, { handler: approve }),
  ],
});
```

Hooks let you intercept lifecycle events, transform interaction responses, and
recover from tool errors. See `examples/deep_dives/agent_middleware.ts` and
`examples/deep_dives/host_tool_hooks.ts`.

### Triggers

Run background tasks that react to external events and push messages into the
agent:

```ts
import { Agent, LocalAgentConfig, TriggerContext, every } from "google-antigravity";

async function checkStatus(ctx: TriggerContext): Promise<void> {
  await ctx.send("Check the deployment status.");
}

const agent = await Agent.start(
  new LocalAgentConfig({
    triggers: [every(60, checkStatus)],
  }),
);
```

### Structured Output

Provide a JSON Schema object, JSON string, or Zod schema to constrain final
output:

```ts
import { z } from "zod";

const schema = z.object({
  actionItems: z.array(
    z.object({
      assignee: z.string(),
      task: z.string(),
      deadline: z.string(),
    }),
  ),
});

const agent = await Agent.start(
  new LocalAgentConfig({
    responseSchema: schema,
  }),
);

const response = await agent.chat("Return action items from the meeting.");
console.log(await response.structuredOutput());
```

## Architecture

The SDK follows the same layered model as the Python package:

| Layer                | Purpose                            | Key Classes                                                                                                    |
| :------------------- | :--------------------------------- | :------------------------------------------------------------------------------------------------------------- |
| Layer 1 - Simplified | High-level entry point             | `Agent`                                                                                                        |
| Layer 2 - Session    | Stateful session and orchestration | `Conversation`, `ChatResponse`, `Step`, `ToolCall`, `AgentConfig`, `HookRunner`, `ToolRunner`, `TriggerRunner` |
| Layer 3 - Adapter    | Transport and backend abstraction  | `Connection`, `ConnectionStrategy`, `LocalConnectionStrategy`                                                  |

## Examples

TypeScript examples live in [`examples/`](examples/).

The getting-started examples cover hello-world chat, streaming, custom tools,
policies, hooks, structured output, multimodal input, MCP tools, triggers,
persistence, persona configuration, autonomous shell access, human-in-the-loop
interactions, observability, error handling, skill loading, app data directory
overrides, and subagents.

The deep-dive examples mirror the Python SDK's multi-feature mini-applications:
middleware, lifecycle hooks, multi-agent chat, multimodal pipelines,
autonomous maintenance agents, and an interactive CLI.

```bash
bun examples/getting_started/hello_world.ts
bun examples/deep_dives/interactive_cli.ts --show-usage
```

## Component Documentation

The TypeScript source mirrors the Python SDK's component layout:

- [Agent](src/agent.ts) - high-level, batteries-included entry point.
- [Connections](src/connections/) - transport and backend abstractions.
- [Local connection](src/connections/local/) - local runtime strategy, config, models, and test harness utilities.
- [Conversation](src/conversation/) - stateful session management and streaming responses.
- [Hooks](src/hooks/) - lifecycle interception and policy helpers.
- [MCP](src/mcp/) - Model Context Protocol integration.
- [Tools](src/tools/) - in-process tool execution and tool context state.
- [Triggers](src/triggers/) - background tasks and external events.
- [Types](src/types.ts) - shared model, media, usage, MCP, and structured-output types.

The public API is idiomatic TypeScript by default. Many Python-style snake_case
aliases are included for migration compatibility, including config fields,
conversation helpers, hook decorators, policy helpers, tool runner helpers, and
runtime model serialization. Package subpaths also include underscored aliases
for Python module names such as `connections/local/local_connection`.

## Verification

```bash
bun test
bun run typecheck
bun run typecheck:examples
bun run build
```

## License

[Apache License 2.0](LICENSE)
