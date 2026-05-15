import { Buffer } from "node:buffer";

import { Effect, FileSystem, Layer, Path } from "effect";

import {
  WorkspaceFileSystem,
  WorkspaceFileSystemError,
  type WorkspaceFileSystemShape,
} from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspacePaths } from "../Services/WorkspacePaths.ts";

const MAX_PROJECT_ARTIFACT_READ_BYTES = 2 * 1024 * 1024;

const IMAGE_MIME_TYPES_BY_EXTENSION = new Map<string, string>([
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);

const TEXT_MIME_TYPES_BY_EXTENSION = new Map<string, string>([
  [".css", "text/css"],
  [".csv", "text/csv"],
  [".html", "text/html"],
  [".js", "text/javascript"],
  [".json", "application/json"],
  [".jsonc", "application/json"],
  [".jsx", "text/javascript"],
  [".md", "text/markdown"],
  [".mdx", "text/markdown"],
  [".toml", "text/plain"],
  [".ts", "text/typescript"],
  [".tsx", "text/typescript"],
  [".txt", "text/plain"],
  [".xml", "application/xml"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"],
]);

function getLowercaseExtension(relativePath: string): string {
  const basename = relativePath.split("/").pop() ?? relativePath;
  const dotIndex = basename.lastIndexOf(".");
  return dotIndex > 0 ? basename.slice(dotIndex).toLowerCase() : "";
}

function hasNullByte(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte === 0) return true;
  }
  return false;
}

function toDataUrl(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

export const makeWorkspaceFileSystem = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries;

  const readFile: WorkspaceFileSystemShape["readFile"] = Effect.fn("WorkspaceFileSystem.readFile")(
    function* (input) {
      const target = yield* workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });

      const fileInfo = yield* fileSystem.stat(target.absolutePath).pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceFileSystemError({
              cwd: input.cwd,
              relativePath: input.relativePath,
              operation: "workspaceFileSystem.stat",
              detail: cause.message,
              cause,
            }),
        ),
      );

      if (fileInfo.type !== "File") {
        return {
          relativePath: target.relativePath,
          kind: "unsupported" as const,
          mimeType: null,
          sizeBytes: 0,
          reason: "Only regular files can be previewed.",
        };
      }

      const sizeBytes = Number(fileInfo.size);
      if (sizeBytes > MAX_PROJECT_ARTIFACT_READ_BYTES) {
        return {
          relativePath: target.relativePath,
          kind: "unsupported" as const,
          mimeType: null,
          sizeBytes,
          reason: "File is too large to preview in ShioriCode.",
        };
      }

      const bytes = yield* fileSystem.readFile(target.absolutePath).pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceFileSystemError({
              cwd: input.cwd,
              relativePath: input.relativePath,
              operation: "workspaceFileSystem.readFile",
              detail: cause.message,
              cause,
            }),
        ),
      );
      const extension = getLowercaseExtension(target.relativePath);

      if (extension === ".pdf") {
        const mimeType = "application/pdf";
        return {
          relativePath: target.relativePath,
          kind: "pdf" as const,
          mimeType,
          sizeBytes: bytes.byteLength,
          dataUrl: toDataUrl(bytes, mimeType),
        };
      }

      const imageMimeType = IMAGE_MIME_TYPES_BY_EXTENSION.get(extension);
      if (imageMimeType) {
        return {
          relativePath: target.relativePath,
          kind: "image" as const,
          mimeType: imageMimeType,
          sizeBytes: bytes.byteLength,
          dataUrl: toDataUrl(bytes, imageMimeType),
        };
      }

      if (!hasNullByte(bytes)) {
        const mimeType = TEXT_MIME_TYPES_BY_EXTENSION.get(extension) ?? "text/plain";
        return {
          relativePath: target.relativePath,
          kind: "text" as const,
          mimeType,
          sizeBytes: bytes.byteLength,
          contents: new TextDecoder("utf-8").decode(bytes),
        };
      }

      return {
        relativePath: target.relativePath,
        kind: "unsupported" as const,
        mimeType: null,
        sizeBytes: bytes.byteLength,
        reason: "Binary file previews are not supported yet.",
      };
    },
  );

  const writeFile: WorkspaceFileSystemShape["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.makeDirectory",
            detail: cause.message,
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFileString(target.absolutePath, input.contents).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.writeFile",
            detail: cause.message,
            cause,
          }),
      ),
    );
    yield* workspaceEntries.invalidate(input.cwd);
    return { relativePath: target.relativePath };
  });
  return { readFile, writeFile } satisfies WorkspaceFileSystemShape;
});

export const WorkspaceFileSystemLive = Layer.effect(WorkspaceFileSystem, makeWorkspaceFileSystem);
