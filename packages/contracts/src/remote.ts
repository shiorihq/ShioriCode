import * as Schema from "effect/Schema";

/**
 * Schemas for the Remote settings panel: managing how this machine's ShioriCode
 * server is exposed, the owner credential, and connected device sessions.
 */

export const REMOTE_EXPOSURE_METHODS = ["off", "tailscale-serve", "tailscale-funnel"] as const;
export const RemoteExposureMethod = Schema.Literals(REMOTE_EXPOSURE_METHODS);
export type RemoteExposureMethod = typeof RemoteExposureMethod.Type;

export const RemoteReachability = Schema.Literals([
  "loopback",
  "lan",
  "tailnet",
  "public",
  "unknown",
]);
export type RemoteReachability = typeof RemoteReachability.Type;

export const RemoteSessionSummary = Schema.Struct({
  id: Schema.String,
  username: Schema.String,
  label: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  expiresAt: Schema.String,
  lastSeenAt: Schema.String,
});
export type RemoteSessionSummary = typeof RemoteSessionSummary.Type;

export const RemoteTailscaleStatus = Schema.Struct({
  /** Whether the tailscale CLI was found on this machine. */
  installed: Schema.Boolean,
  /** Whether the tailscale daemon is connected (BackendState=Running). */
  running: Schema.Boolean,
  /** This node's MagicDNS name, e.g. machine.tailnet.ts.net (no trailing dot). */
  dnsName: Schema.NullOr(Schema.String),
  /** Whether the tailnet can provision TLS certs (needed for HTTPS serve). */
  httpsEnabled: Schema.Boolean,
});
export type RemoteTailscaleStatus = typeof RemoteTailscaleStatus.Type;

export const RemoteStatus = Schema.Struct({
  /** Currently active exposure method. */
  method: RemoteExposureMethod,
  /** Whether remote access is exposed at all (method !== off). */
  enabled: Schema.Boolean,
  /** The reachable URL, when known (e.g. https://machine.tailnet.ts.net). */
  url: Schema.NullOr(Schema.String),
  reachability: RemoteReachability,
  /** Whether a valid login is required (server started remote-reachable). */
  requireAuth: Schema.Boolean,
  /** Whether an owner credential has been set. */
  authConfigured: Schema.Boolean,
  username: Schema.NullOr(Schema.String),
  /** Local port the server listens on (what a proxy/tunnel targets). */
  port: Schema.Number,
  tailscale: RemoteTailscaleStatus,
  sessions: Schema.Array(RemoteSessionSummary),
  /** A human note for the current state (e.g. why HTTPS is unavailable). */
  notice: Schema.NullOr(Schema.String),
});
export type RemoteStatus = typeof RemoteStatus.Type;

export const RemoteSetCredentialsInput = Schema.Struct({
  username: Schema.String,
  password: Schema.String,
});
export type RemoteSetCredentialsInput = typeof RemoteSetCredentialsInput.Type;

export const RemoteSetExposureInput = Schema.Struct({
  method: RemoteExposureMethod,
});
export type RemoteSetExposureInput = typeof RemoteSetExposureInput.Type;

export const RemoteRevokeSessionInput = Schema.Struct({
  sessionId: Schema.String,
});
export type RemoteRevokeSessionInput = typeof RemoteRevokeSessionInput.Type;

export class RemoteError extends Schema.TaggedErrorClass<RemoteError>()("RemoteError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}
