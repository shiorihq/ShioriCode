# Slice 04 — Durable Execution Graph

## Contract

After journal replay or process restart, execution identity, ancestry, dependencies, aliases, and lifecycle match the pre-restart graph. Novel native events remain queryable through bounded diagnostics while hot snapshots stay small.

## Seam

A normalizer consumes typed provider execution facts and appends graph deltas. SQLite projections own runs, nodes, edges, aliases, and latest state. A separate bounded raw-envelope store records source/version/disposition. Graph and paged node-detail RPCs are independent of the primary thread snapshot.

Reuse the existing event-store append, projection checkpoint, rebuild, and replay sequencing.

## Playable evidence

A server integration probe ingests an out-of-order multi-agent fixture, snapshots the graph, rebuilds projections from the journal, and compares both outputs.

## Verification

Cover duplicate delivery, child-before-parent, unresolved aliases, bounded fallback, ambiguous candidates, restart, rotation limits, malformed/unknown dispositions, and thousands of nodes. Confirm raw content never enters normal activity/snapshot responses.

## Firewalls

Activities do not own identity. Raw envelopes are diagnostics, not canonical replay input. No unbounded in-memory ancestry map may be required for correctness.

## Human feedback

Feedback changes this slice if graph queries are too heavy for thread-open latency; prefer pagination and lazy loading over snapshot expansion.
