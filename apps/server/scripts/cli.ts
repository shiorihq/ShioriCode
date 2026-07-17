#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Data, Effect, FileSystem, Logger, Option, Path } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  DEVELOPMENT_ICON_OVERRIDES,
  PUBLISH_ICON_OVERRIDES,
} from "../../../scripts/lib/brand-assets.ts";
import { resolveCatalogDependencies } from "../../../scripts/lib/resolve-catalog.ts";
import rootPackageJson from "../../../package.json" with { type: "json" };
import serverPackageJson from "../package.json" with { type: "json" };

class CliError extends Data.TaggedError("CliError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("../../..", import.meta.url))),
);

const runCommand = Effect.fn("runCommand")(function* (command: ChildProcess.Command) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);
  const exitCode = yield* child.exitCode;

  if (exitCode !== 0) {
    return yield* new CliError({
      message: `Command exited with non-zero exit code (${exitCode})`,
    });
  }
});

const applyPublishIconOverrides = Effect.fn("applyPublishIconOverrides")(function* (
  repoRoot: string,
  packageDir: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  for (const override of PUBLISH_ICON_OVERRIDES) {
    const sourcePath = path.join(repoRoot, override.sourceRelativePath);
    const targetPath = path.join(packageDir, override.targetRelativePath);

    if (!(yield* fs.exists(sourcePath))) {
      return yield* new CliError({
        message: `Missing publish icon source: ${sourcePath}`,
      });
    }
    if (!(yield* fs.exists(targetPath))) {
      return yield* new CliError({
        message: `Missing publish icon target: ${targetPath}. Run the build subcommand first.`,
      });
    }

    yield* fs.copyFile(sourcePath, targetPath);
  }

  yield* Effect.log("[cli] Applied publish icon overrides to dist/client");
});

const applyDevelopmentIconOverrides = Effect.fn("applyDevelopmentIconOverrides")(function* (
  repoRoot: string,
  serverDir: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  for (const override of DEVELOPMENT_ICON_OVERRIDES) {
    const sourcePath = path.join(repoRoot, override.sourceRelativePath);
    const targetPath = path.join(serverDir, override.targetRelativePath);

    if (!(yield* fs.exists(sourcePath))) {
      return yield* new CliError({
        message: `Missing development icon source: ${sourcePath}`,
      });
    }
    if (!(yield* fs.exists(targetPath))) {
      return yield* new CliError({
        message: `Missing development icon target: ${targetPath}. Build web first.`,
      });
    }

    yield* fs.copyFile(sourcePath, targetPath);
  }

  yield* Effect.log("[cli] Applied development icon overrides to dist/client");
});

// ---------------------------------------------------------------------------
// build subcommand
// ---------------------------------------------------------------------------

const buildCmd = Command.make(
  "build",
  {
    verbose: Flag.boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");

      yield* Effect.log("[cli] Running tsdown...");
      yield* runCommand(
        ChildProcess.make({
          cwd: serverDir,
          stdout: config.verbose ? "inherit" : "ignore",
          stderr: "inherit",
          // Windows needs shell mode to resolve .cmd shims (e.g. bun.cmd).
          shell: process.platform === "win32",
        })`bun tsdown`,
      );

      const webDist = path.join(repoRoot, "apps/web/dist");
      const clientTarget = path.join(serverDir, "dist/client");

      if (yield* fs.exists(webDist)) {
        yield* fs.copy(webDist, clientTarget);
        yield* applyDevelopmentIconOverrides(repoRoot, serverDir);
        yield* Effect.log("[cli] Bundled web app into dist/client");
      } else {
        yield* Effect.logWarning("[cli] Web dist not found — skipping client bundle.");
      }
    }),
).pipe(Command.withDescription("Build the server package (tsdown + bundle web client)."));

// ---------------------------------------------------------------------------
// publish subcommand
// ---------------------------------------------------------------------------

const publishCmd = Command.make(
  "publish",
  {
    tag: Flag.string("tag").pipe(Flag.withDefault("latest")),
    access: Flag.string("access").pipe(Flag.withDefault("public")),
    appVersion: Flag.string("app-version").pipe(Flag.optional),
    provenance: Flag.boolean("provenance").pipe(Flag.withDefault(false)),
    dryRun: Flag.boolean("dry-run").pipe(Flag.withDefault(false)),
    packDestination: Flag.string("pack-destination").pipe(Flag.optional),
    verbose: Flag.boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");

      // Assert build assets exist
      for (const relPath of ["dist/bin.mjs", "dist/client/index.html"]) {
        const abs = path.join(serverDir, relPath);
        if (!(yield* fs.exists(abs))) {
          return yield* new CliError({
            message: `Missing build asset: ${abs}. Run the build subcommand first.`,
          });
        }
      }

      // Stage outside the monorepo. npm 11 can mis-pack a temporarily rewritten
      // workspace package, and publishing from an isolated directory also keeps
      // release-time asset overrides from mutating the working tree.
      const packageDir = yield* fs.makeTempDirectoryScoped({ prefix: "shioricode-publish-" });
      const version = Option.getOrElse(config.appVersion, () => serverPackageJson.version);
      const pkg = {
        name: serverPackageJson.name,
        description: serverPackageJson.description,
        license: serverPackageJson.license,
        repository: serverPackageJson.repository,
        bin: serverPackageJson.bin,
        type: serverPackageJson.type,
        version,
        engines: serverPackageJson.engines,
        files: serverPackageJson.files,
        publishConfig: serverPackageJson.publishConfig,
        dependencies: Object.fromEntries(
          Object.entries(serverPackageJson.dependencies).filter(
            ([, spec]) => !spec.startsWith("workspace:"),
          ),
        ) as Record<string, unknown>,
      };

      pkg.dependencies = resolveCatalogDependencies(
        pkg.dependencies,
        rootPackageJson.workspaces.catalog,
        "apps/server dependencies",
      );

      yield* fs.copy(path.join(serverDir, "dist"), path.join(packageDir, "dist"));
      yield* fs.copyFile(path.join(serverDir, "README.md"), path.join(packageDir, "README.md"));
      yield* fs.writeFileString(
        path.join(packageDir, "package.json"),
        `${JSON.stringify(pkg, null, 2)}\n`,
      );
      yield* Effect.log("[cli] Staged resolved package for publish");
      yield* applyPublishIconOverrides(repoRoot, packageDir);

      const args = Option.match(config.packDestination, {
        onNone: () => ["publish", "--access", config.access, "--tag", config.tag],
        onSome: (destination) => ["pack", "--pack-destination", destination],
      });
      if (Option.isNone(config.packDestination)) {
        if (config.provenance) args.push("--provenance");
        if (config.dryRun) args.push("--dry-run");
      }

      yield* Effect.log(`[cli] Running: npm ${args.join(" ")}`);
      yield* runCommand(
        ChildProcess.make("npm", [...args], {
          cwd: packageDir,
          stdin: "inherit",
          stdout: config.verbose ? "inherit" : "ignore",
          stderr: "inherit",
          // Windows needs shell mode to resolve .cmd shims.
          shell: process.platform === "win32",
        }),
      );
    }),
).pipe(Command.withDescription("Publish the server package to npm."));

// ---------------------------------------------------------------------------
// root command
// ---------------------------------------------------------------------------

const cli = Command.make("cli").pipe(
  Command.withDescription("T3 server build & publish CLI."),
  Command.withSubcommands([buildCmd, publishCmd]),
);

Command.run(cli, { version: "0.0.0" }).pipe(
  Effect.scoped,
  Effect.provide([Logger.layer([Logger.consolePretty()]), NodeServices.layer]),
  NodeRuntime.runMain,
);
