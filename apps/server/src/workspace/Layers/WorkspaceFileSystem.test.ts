import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { ServerConfig } from "../../config.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspaceFileSystem } from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceEntriesLive } from "./WorkspaceEntries.ts";
import { WorkspaceFileSystemLive } from "./WorkspaceFileSystem.ts";
import { WorkspacePathsLive } from "./WorkspacePaths.ts";

const ProjectLayer = WorkspaceFileSystemLive.pipe(
  Layer.provide(WorkspacePathsLive),
  Layer.provide(WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive))),
);

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectLayer),
  Layer.provideMerge(WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive))),
  Layer.provideMerge(WorkspacePathsLive),
  Layer.provideMerge(GitCoreLive),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-files-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "shioricode-workspace-files-",
  });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents = "",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

it.layer(TestLayer)("WorkspaceFileSystemLive", (it) => {
  describe("readFile", () => {
    it.effect("reads text artifacts relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "plans/effect-rpc.md", "# Plan\n");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
        });

        expect(result).toEqual({
          relativePath: "plans/effect-rpc.md",
          kind: "text",
          mimeType: "text/markdown",
          sizeBytes: 7,
          contents: "# Plan\n",
        });
      }),
    );

    it.effect("reads image artifacts as data URLs", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const absolutePath = path.join(cwd, "images/pixel.png");
        yield* fileSystem
          .makeDirectory(path.dirname(absolutePath), { recursive: true })
          .pipe(Effect.orDie);
        yield* fileSystem
          .writeFile(absolutePath, Uint8Array.from([137, 80, 78, 71]))
          .pipe(Effect.orDie);

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "images/pixel.png",
        });

        expect(result).toEqual({
          relativePath: "images/pixel.png",
          kind: "image",
          mimeType: "image/png",
          sizeBytes: 4,
          dataUrl: "data:image/png;base64,iVBORw==",
        });
      }),
    );

    it.effect("does not read oversized artifacts into memory", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const absolutePath = path.join(cwd, "large-output.md");
        yield* fileSystem
          .writeFile(absolutePath, new Uint8Array(2 * 1024 * 1024 + 1))
          .pipe(Effect.orDie);

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "large-output.md",
        });

        expect(result).toEqual({
          relativePath: "large-output.md",
          kind: "unsupported",
          mimeType: null,
          sizeBytes: 2 * 1024 * 1024 + 1,
          reason: "File is too large to preview in ShioriCode.",
        });
      }),
    );

    it.effect("rejects reads outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .readFile({
            cwd,
            relativePath: "../escape.md",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );
      }),
    );
  });

  describe("writeFile", () => {
    it.effect("writes files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });
        const saved = yield* fileSystem
          .readFileString(path.join(cwd, "plans/effect-rpc.md"))
          .pipe(Effect.orDie);

        expect(result).toEqual({ relativePath: "plans/effect-rpc.md" });
        expect(saved).toBe("# Plan\n");
      }),
    );

    it.effect("invalidates workspace entry search cache after writes", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries;
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/existing.ts", "export {};\n");

        const beforeWrite = yield* workspaceEntries.search({
          cwd,
          query: "rpc",
          limit: 10,
        });
        expect(beforeWrite).toEqual({
          entries: [],
          truncated: false,
        });

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });

        const afterWrite = yield* workspaceEntries.search({
          cwd,
          query: "rpc",
          limit: 10,
        });
        expect(afterWrite.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "plans/effect-rpc.md" })]),
        );
        expect(afterWrite.truncated).toBe(false);
      }),
    );

    it.effect("rejects writes outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "../escape.md",
            contents: "# nope\n",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );

        const escapedPath = path.resolve(cwd, "..", "escape.md");
        const escapedStat = yield* fileSystem
          .stat(escapedPath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        expect(escapedStat).toBeNull();
      }),
    );
  });
});
