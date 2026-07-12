# Slice 03 — Native Envelope Retention

## Contract

Every native provider envelope is recorded before adapter filtering with a bounded disposition: `recognized`, `unknown`, `invalid`, or `intentionally-ignored`. Unknown protocol behavior remains diagnosable without entering transcript activities or hot snapshots.

## Seam

`NativeEnvelopeStore.append(envelope)` persists version, source, provider/session/thread references, receive sequence, redacted payload, and storage bounds. `recordDisposition(envelopeId, disposition)` records normalization outcome. `getDiagnosticSummary` exposes aggregate method/version counts only.

Retention owns payload evidence; runtime warnings and UI activities never copy complete native messages.

## Playable evidence

A server probe ingests recognized, malformed, unknown, and intentionally ignored fixtures, prints aggregate dispositions, rotates the store, restarts, and queries the same bounded summary.

## Verification

Add persistence tests covering recording before filtering, redaction, duplicate delivery, age/count/byte rotation, deletion, restart, and aggregate diagnostics. Assert raw payloads are absent from orchestration activities, thread snapshots, and transcript APIs.

Acceptance verdict: protocol drift can be diagnosed after restart while retained bytes and all hot read models remain within configured bounds.

## Firewalls

Native envelopes are diagnostic evidence, not canonical graph replay input. Do not implement execution identity, ancestry, controls, or transcript rendering here.

## Human feedback

Feedback changes this slice if retention limits are too costly or redact necessary correlation fields. Prefer explicit retained identifiers over retaining whole sensitive payloads.

Before ending, update the README handoff and record the probe/test evidence path.
