import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeSqlitePersistenceLive, SQLITE_BUSY_TIMEOUT_MS } from "./Sqlite.ts";

it.effect("configures a busy timeout on sqlite connections", () =>
  Effect.gen(function* () {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shioricode-sqlite-"));
    const dbPath = path.join(tempDir, "state.sqlite");
    const persistenceLayer = makeSqlitePersistenceLive(dbPath);

    try {
      const rows = yield* Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql.unsafe<{ readonly timeout: number }>("PRAGMA busy_timeout;", []);
        }).pipe(Effect.provide(persistenceLayer)),
      );

      assert.equal(rows[0]?.timeout, SQLITE_BUSY_TIMEOUT_MS);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
