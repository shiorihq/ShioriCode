# Slice 01 — Protocol Oracles

## Contract

A redacted, version-stamped native fixture can be replayed through its provider adapter and deterministically produce canonical runtime events. Unknown input remains observable rather than disappearing.

## Seam

Fixtures live under `assets/fixtures/{claude,codex}` with adjacent provenance metadata. Adapter test helpers accept the native envelope sequence and return canonical events plus dispositions. Production capture remains opt-in and must not be required by tests.

## Playable evidence

Run focused Claude and Codex adapter replay tests. A small fixture-report command or test output should show native families, recognized families, and unknown dispositions without printing sensitive payloads.

## Verification

Cover nested and parallel agents, task/progress lifecycle, permission waits, retries/failures, out-of-order events, and one intentionally unknown event per provider. Keep legacy adapter fixtures green. Confirm redaction removes prompts, paths, tokens, and personal identifiers.

Then run the global gates in the feature README.

## Firewalls

Do not change domain contracts yet. Do not infer workflow/team fields missing from captures. Do not check in raw home-directory transcripts.

## Human feedback

Feedback changes this slice only if the fixture corpus omits a currently important real flow or retains sensitive content. Review is non-blocking.
