# ShioriCode

A minimal web GUI for coding agents — currently supporting **Shiori**, **Codex**, **Claude**, and **Kimi**.

> [!WARNING]
> ShioriCode is in early development. APIs and features may change without notice.

---

## Prerequisites

Before running ShioriCode, install and authenticate at least one provider:

| Provider   | Installation                                                                            | Authentication      |
| ---------- | --------------------------------------------------------------------------------------- | ------------------- |
| **Codex**  | [Codex CLI](https://github.com/openai/codex)                                            | `codex login`       |
| **Claude** | [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview) | `claude auth login` |
| **Kimi**   | [Kimi Code CLI](https://www.moonshot.cn/) (`kimi`)                                      | `kimi login`        |

> The hosted **Shiori** provider requires Convex setup (see below). It will remain in a warning state until you sign in through the **Settings** panel.

---

## Quick Start

```bash
# Install dependencies
bun install

# Set up environment
cp apps/web/.env.example apps/web/.env.local
# Edit apps/web/.env.local and set VITE_CONVEX_URL

# Start Convex (required for Shiori hosted provider)
bun run convex:dev

# Start the app
bun run dev
```

---

## Convex Setup (Hosted Shiori Provider)

Shiori's hosted provider uses [Convex](https://convex.dev/) for authentication and the model catalog.

1. Copy `apps/web/.env.example` to `apps/web/.env.local` and set `VITE_CONVEX_URL`.
2. Start Convex locally:
   ```bash
   bun run convex:dev
   ```
3. Configure GitHub OAuth in your Convex deployment:
   ```bash
   npx convex env set AUTH_GITHUB_ID     <github-client-id>
   npx convex env set AUTH_GITHUB_SECRET <github-client-secret>
   ```
4. Start the app:
   ```bash
   bun run dev
   ```

---

## Project Structure

This is a Bun monorepo managed with Turborepo.

```
├── apps/
│   ├── server/          # Node.js WebSocket server (brokers agent sessions)
│   ├── web/             # React + Vite frontend
│   ├── desktop/         # Electron desktop app
│   ├── cli/             # CLI tooling
│   ├── agent/           # Agent runtime
│   └── marketing/       # Marketing site
├── packages/
│   ├── contracts/       # Shared Effect schemas & TypeScript contracts
│   └── shared/          # Shared runtime utilities (subpath exports)
└── scripts/             # Build & development scripts
```

### Key Packages

| Package              | Role                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `apps/server`        | Wraps Codex app-server (JSON-RPC over stdio), serves the React app, manages provider sessions |
| `apps/web`           | Session UX, conversation/event rendering, client-side state                                   |
| `packages/contracts` | Schema-only — provider events, WebSocket protocol, model/session types                        |
| `packages/shared`    | Runtime utilities consumed by both server and web                                             |

---

## Development

| Command              | Description                     |
| -------------------- | ------------------------------- |
| `bun run dev`        | Start server + web concurrently |
| `bun run dev:server` | Start server only               |
| `bun run dev:web`    | Start web only                  |
| `bun run convex:dev` | Start Convex dev server         |
| `bun run typecheck`  | Type-check all packages         |
| `bun run lint`       | Run Oxlint across the repo      |
| `bun run fmt`        | Format with oxfmt               |
| `bun run test`       | Run all tests (Vitest)          |
| `bun run build`      | Production build                |

---

## Requirements

- [Bun](https://bun.sh/) `^1.3.9`
- [Node.js](https://nodejs.org/) `^24.13.1`

---

## License

MIT
