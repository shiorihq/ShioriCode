# ShioriCode Launch Process

This is the short operational flow for launching ShioriCode locally and confirming the app is fully up.

## Prepare

1. Run `bun install`.
2. If you want the hosted Shiori provider, copy `apps/web/.env.example` to `apps/web/.env.local` and set `VITE_CONVEX_URL`.
3. If you use Convex locally, start it with `bun run convex:dev`.

## Launch

1. Run `bun run dev` from the repo root.
2. The dev runner starts the server and web app together.
3. Open the browser client and wait for the initial orchestration snapshot/bootstrap to finish.

## Verify

1. Confirm the sidebar loads without reconnect churn.
2. Create or open a thread and verify orchestration events begin streaming.
3. Check Settings and confirm at least one provider is ready.
4. If you use hosted Shiori, sign in and confirm the warning state clears.

## Before Shipping

1. Run `bun fmt`.
2. Run `bun lint`.
3. Run `bun typecheck`.
4. For packaged releases, follow [docs/release.md](/Users/choki/Developer/shiori-code/docs/release.md).
