# Slice 05 — Claude Orchestration

## Contract

Observed Claude SDK events produce exact, typed execution facts for delegated agents and for workflow/team facets the active version actually exposes. Permission, retry, waiting, failure, and completion states remain attached to the correct node.

## Seam

`ClaudeAdapter` maps native IDs and `parent_tool_use_id` before any legacy matcher. Description/type matching is a bounded fallback with recorded provenance. Native unknowns receive dispositions. Child transcript references feed the paged node-detail query.

Structured user input preserves single-select, multi-select, and free-form questions end to end.

## Playable evidence

Replay the Claude corpus and open node details from a server integration fixture. Compare canonical output across the supported SDK/CLI fixture versions.

## Verification

Cover parallel same-description agents, nested agents, foreground/background, permission waits, API retry ownership, failures, hooks without correlatable IDs, experimental fields absent, unknown system/content variants, and output-file fallback. Verify no unknown becomes transcript spam.

## Firewalls

Hooks are supplemental evidence. Workflow workers and team members become first-class only when stable machine-readable identity exists. Do not expose terminal-only controls.

## Human feedback

Feedback changes this slice if a real current Claude capture contradicts the normalized lifecycle or hierarchy.
