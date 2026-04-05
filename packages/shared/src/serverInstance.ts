import path from "node:path";
import { Schema } from "effect";

export const SERVER_INSTANCE_FILE_NAME = "server-instance.json";

export const ServerInstanceRecord = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  port: Schema.Int,
  baseDir: Schema.String,
  startedAt: Schema.String,
  wsUrl: Schema.String,
  authToken: Schema.NullOr(Schema.String),
  launcher: Schema.optional(Schema.String),
});
export type ServerInstanceRecord = typeof ServerInstanceRecord.Type;

export const decodeServerInstanceRecord = Schema.decodeUnknownSync(ServerInstanceRecord);
export const encodeServerInstanceRecord = Schema.encodeSync(ServerInstanceRecord);

export function getServerInstancePath(baseDir: string): string {
  return path.join(baseDir, SERVER_INSTANCE_FILE_NAME);
}
