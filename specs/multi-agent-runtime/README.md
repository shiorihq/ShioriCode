# Multi-Agent Runtime

## Next Agent Prompt

**Status (2026-07-11):** Research and slicing are complete. Implementation begins at [Slice 01](slices/01-protocol-oracles.md).

Start by capturing redacted, version-stamped Claude and Codex protocol fixtures and building deterministic adapter replay tests. Do not add workflow/team shapes based only on documentation or UI labels: every normalized field needs fixture or machine-readable runtime evidence. Keep existing behavior green while creating the oracle.

**Warnings:** Claude workflows and agent teams are version-gated; team support is experimental. Codex `ultra` is an observed effort value, not evidence of a distinct “ultracode” protocol. Provider controls are out of scope until a supported operation is advertised.

- [ ] Capture and replay protocol evidence — [Slice 01](slices/01-protocol-oracles.md)
- [ ] Define the execution graph contract — [Slice 02](slices/02-execution-contracts.md)
- [ ] Retain bounded native envelopes — [Slice 03](slices/03-native-envelope-retention.md)
- [ ] Project the durable execution graph — [Slice 04](slices/04-durable-execution-graph.md)
- [ ] Normalize modern Claude orchestration — [Slice 05](slices/05-claude-orchestration.md)
- [ ] Correct Codex ancestry and lifecycle — [Slice 06](slices/06-codex-orchestration.md)
- [ ] Make capability discovery authoritative — [Slice 07](slices/07-runtime-capabilities.md)
- [ ] Centralize derivation and lazy detail — [Slice 08](slices/08-shared-derivation.md)
- [ ] Ship the compact live hierarchy — [Slice 09](slices/09-live-hierarchy.md)

Before ending your pass, update this status, checklist, warnings, and exact next pickup point.

## Goal

Make concurrent agent work legible and recoverable without turning the main conversation into a debug log. A user should see a compact live tree of delegated agents, workflow phases, team tasks, nested tools, waits, retries, and failures; details should load only when requested.

The feature treats provider behavior as evidence-driven protocol, not branding. Claude delegated agents, workflows, and teams are related but different execution domains. Codex collaboration uses its own app-server semantics. The shared model preserves those differences rather than declaring one provider universal.

## The execution graph

The **execution graph** is the sole owner of orchestration identity and lifecycle. It records runs, nodes, provider aliases, containment/spawn/dependency edges, execution mode, and state. Provider adapters report facts; a central normalizer assigns stable Shiori identity; the event journal and projections make the result replayable.

Thread activities remain concise history and presentation inputs. They must never become a second identity database. Long transcripts and native envelopes stay out of hot snapshots and are fetched lazily.

See [the architecture visualization](visualizations/execution-hierarchy.html) for the ownership and data-flow boundaries.

## Invariants

1. Prefer exact provider identifiers. A bounded fallback records its provenance; ambiguity remains unresolved.
2. Persist identity before relying on it for routing. Restart and replay must reconstruct the same tree.
3. Retain novel provider envelopes with a disposition, but summarize diagnostics outside the transcript.
4. Discover capabilities at runtime. Built-ins are offline fallback metadata, not authority.
5. Keep the current event journal, recovery coordinator, and recursive timeline renderer.
6. Share lifecycle folding and tree derivation across transcript, composer, sidebar, and detail views.
7. Compatibility bridges are migration-only: the legacy activity fallback is removed after every supported provider emits graph deltas and legacy fixture replay is migrated; `getSubagentDetail` is removed after all bundled clients use paged node detail. Neither bridge may gain new semantics.
8. Expose no control that lacks an authenticated, machine-readable provider operation and defined failure semantics.
9. Bound raw retention, progress update frequency, detail pages, and every snapshot projection.

## Review map

Each slice has one verdict and leaves a runnable/testable seam. Protocol slices use fixture replay. Persistence slices use projection rebuild and restart. The final web slice uses a browser fixture route, performance cases, accessibility checks, and visual evidence.

Any changed visual surface requires an independent `screenshot-critique` as its final check. Where a prior screenshot exists, use `compare-screenshots` first to compare candidate against baseline. Human screenshot review is non-blocking: open evidence, allow roughly five minutes, then decide from the recorded evidence if no response arrives.

## Sources

- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude Agent SDK subagents](https://code.claude.com/docs/en/agent-sdk/subagents)
- [Claude Code workflows](https://code.claude.com/docs/en/workflows)
- [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams)
- [Claude Code headless mode](https://code.claude.com/docs/en/headless)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Codex app-server protocol](https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol)
- [Codex multi-agent handlers](https://github.com/openai/codex/tree/main/codex-rs/core/src/tools/handlers/multi_agents)

## Global verification

Every implementation pass runs focused tests and then:

```sh
bun run test
bun fmt
bun lint
bun typecheck
```

Never use `bun test` in this repository.
