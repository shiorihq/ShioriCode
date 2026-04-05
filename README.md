# ShioriCode

ShioriCode is a minimal web GUI for coding agents (currently Sihori, Codex and Claude, more coming soon).

## Installation

> [!WARNING]
> ShioriCode currently supports Shiori, Codex and Claude.
> Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://github.com/openai/codex) and run `codex login`
> - Claude: install Claude Code and run `claude auth login`

## Convex setup

Shiori's hosted provider now uses Convex for user authentication and the hosted model catalog.

1. Install dependencies with `bun install`.
2. Copy [apps/web/.env.example](apps/web/.env.example) to `apps/web/.env.local` and set `VITE_CONVEX_URL`.
3. Start Convex locally with `bun run convex:dev`.
4. In your Convex deployment, set GitHub OAuth secrets:
   - `npx convex env set AUTH_GITHUB_ID <github-client-id>`
   - `npx convex env set AUTH_GITHUB_SECRET <github-client-secret>`
5. Start the app with `bun run dev`.

The hosted Shiori provider will stay in a warning state until the user signs in through the Settings panel.
