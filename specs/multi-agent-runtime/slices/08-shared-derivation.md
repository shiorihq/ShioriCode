# Slice 08 — Shared Derivation and Lazy Detail

## Contract

Transcript, composer, sidebar, and detail views derive the same hierarchy and lifecycle from the execution graph. Long details load only on demand and page independently.

## Seam

A shared runtime module owns descendant closure, lifecycle folding, status, alias/name selection, and graph-to-work-row adaptation. It feeds existing `itemId`/`parentItemId` timeline seams. Paged node details return typed metadata, transcript, activity/output, dependency/mailbox, truncation, and diagnostic sections as available.

The old subagent-detail RPC delegates to the new query only during bundled-client migration. Remove it as soon as every bundled web/desktop client calls paged node detail; do not add fields or behaviors to the bridge.

## Playable evidence

A component fixture renders equivalent Claude and Codex graphs through transcript, composer, and sidebar, and opens lazy details for multiple receivers and missing transcripts.

## Verification

Cover pagination, truncation, stale/missing nodes, old RPC compatibility, foreground/background, all terminal states, orphans, three-level nesting, and no fetch before expansion. Remove cross-provider types whose names still imply Codex-only ownership.

## Firewalls

No frontend component parses arbitrary provider payloads to determine identity or lifecycle. Do not load transcripts into the thread snapshot.

## Human feedback

Feedback changes this slice if detail organization hides essential debugging evidence; add a lazy section rather than expanding the hot summary.
