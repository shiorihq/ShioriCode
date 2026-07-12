# Slice 07 — Runtime Capabilities

## Contract

A selected model and runtime action are validated against current machine-readable capabilities. Runtime discovery wins over stale fallback metadata for the same model slug.

## Seam

Provider model resolution merges runtime discovery, user custom settings, and built-in offline fallback in that order. Model capabilities, session/protocol capabilities, and display labels are separate data. Turn start snapshots the validated selection.

## Playable evidence

Provider tests demonstrate same-slug runtime override, offline fallback, custom model handling, and dispatch rejection for unsupported effort/control values.

## Verification

Cover missing/partial discovery, changed defaults, unknown future effort values, service tiers, refresh between turns, and selected capabilities remaining stable during a turn. Advertised `ultra`, `max`, and `xhigh` pass through unchanged.

## Firewalls

“Sol,” “Ultra,” and “ultracode” are not capability checks. No control appears from a version string or model name alone.

## Human feedback

Feedback changes this slice if fallback behavior makes an installed but temporarily unreachable provider unusable; preserve a predictable offline baseline without overriding fresh discovery.
