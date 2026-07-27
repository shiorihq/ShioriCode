import { randomUUID } from "node:crypto";

import { Effect, FileSystem, Option, Path, Result } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse, Multipart } from "effect/unstable/http";

import { authorizeDataRequest } from "./auth/EnvironmentAuth";
import { ServerConfig } from "./config";
import { ServerSettingsService } from "./serverSettings";

const BACKGROUND_ROUTE_PREFIX = "/api/appearance/background/";
const MAX_BACKGROUND_BYTES = 12 * 1024 * 1024;

const BACKGROUND_FORMATS = [
  { mimeType: "image/png", extension: ".png" },
  { mimeType: "image/jpeg", extension: ".jpg" },
  { mimeType: "image/webp", extension: ".webp" },
] as const;

type BackgroundFormat = (typeof BACKGROUND_FORMATS)[number];

function jsonResponse(body: unknown, status: number) {
  return HttpServerResponse.text(JSON.stringify(body), {
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "no-store" },
  });
}

export function detectAppearanceBackgroundFormat(bytes: Uint8Array): BackgroundFormat | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return BACKGROUND_FORMATS[0];
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return BACKGROUND_FORMATS[1];
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return BACKGROUND_FORMATS[2];
  }
  return null;
}

function backgroundFileName(version: string, extension: BackgroundFormat["extension"]): string {
  return `custom-${version}${extension}`;
}

function isBackgroundVersion(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export const appearanceBackgroundUploadRouteLayer = HttpRouter.add(
  "POST",
  "/api/appearance/background",
  Effect.gen(function* () {
    const denied = yield* authorizeDataRequest;
    if (denied) return denied;

    const request = yield* HttpServerRequest.HttpServerRequest;
    const contentLength = Number(request.headers["content-length"] ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_BACKGROUND_BYTES + 1024 * 1024) {
      return jsonResponse(
        { success: false, error: "Background images must be 12MB or smaller." },
        413,
      );
    }

    const config = yield* ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverSettings = yield* ServerSettingsService;
    const multipartResult = yield* request.multipart.pipe(
      Effect.provideServices(
        Multipart.limitsServices({
          maxFileSize: MAX_BACKGROUND_BYTES,
          maxTotalSize: MAX_BACKGROUND_BYTES + 1024 * 1024,
          maxParts: 2,
        }),
      ),
      Effect.result,
    );
    if (Result.isFailure(multipartResult)) {
      const tooLarge =
        multipartResult.failure.reason._tag === "FileTooLarge" ||
        multipartResult.failure.reason._tag === "BodyTooLarge";
      return jsonResponse(
        {
          success: false,
          error: tooLarge ? "Background images must be 12MB or smaller." : "Invalid image upload.",
        },
        tooLarge ? 413 : 400,
      );
    }

    const fileEntry = multipartResult.success.file;
    const uploadedFile = Array.isArray(fileEntry) ? fileEntry[0] : undefined;
    if (!uploadedFile || !Multipart.isPersistedFile(uploadedFile)) {
      return jsonResponse({ success: false, error: "No image file was provided." }, 400);
    }
    const fileInfo = yield* fileSystem.stat(uploadedFile.path);
    const fileSizeBytes = Number(fileInfo.size);
    if (fileSizeBytes === 0 || fileSizeBytes > MAX_BACKGROUND_BYTES) {
      return jsonResponse(
        {
          success: false,
          error: "Background images must be between 1 byte and 12MB.",
        },
        fileSizeBytes > MAX_BACKGROUND_BYTES ? 413 : 400,
      );
    }
    const bytes = yield* fileSystem.readFile(uploadedFile.path);
    const format = detectAppearanceBackgroundFormat(bytes);
    if (!format) {
      return jsonResponse(
        { success: false, error: "Background images must be PNG, JPEG, or WebP files." },
        400,
      );
    }

    const version = randomUUID();
    const fileName = backgroundFileName(version, format.extension);
    const filePath = path.join(config.appearanceBackgroundsDir, fileName);
    const saveResult = yield* Effect.result(
      Effect.gen(function* () {
        yield* fileSystem.makeDirectory(config.appearanceBackgroundsDir, { recursive: true });
        yield* fileSystem.writeFile(filePath, bytes);
        yield* serverSettings.updateSettings({
          appearanceBackground: { kind: "custom", customVersion: version },
        });
      }),
    );

    if (Result.isFailure(saveResult)) {
      yield* fileSystem.remove(filePath).pipe(Effect.catch(() => Effect.void));
      return jsonResponse({ success: false, error: "Failed to save the background image." }, 500);
    }

    const entries = yield* fileSystem
      .readDirectory(config.appearanceBackgroundsDir)
      .pipe(Effect.catch(() => Effect.succeed([])));
    yield* Effect.all(
      entries
        .filter((entry) => entry.startsWith("custom-") && entry !== fileName)
        .map((entry) =>
          fileSystem
            .remove(path.join(config.appearanceBackgroundsDir, entry))
            .pipe(Effect.catch(() => Effect.void)),
        ),
      { concurrency: "unbounded" },
    );

    return jsonResponse({ success: true, data: { version } }, 200);
  }),
);

export const appearanceBackgroundFileRouteLayer = HttpRouter.add(
  "GET",
  `${BACKGROUND_ROUTE_PREFIX}*`,
  Effect.gen(function* () {
    const denied = yield* authorizeDataRequest;
    if (denied) return denied;

    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }
    const version = url.value.pathname.slice(BACKGROUND_ROUTE_PREFIX.length);
    if (!isBackgroundVersion(version)) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const config = yield* ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const format of BACKGROUND_FORMATS) {
      const filePath = path.join(
        config.appearanceBackgroundsDir,
        backgroundFileName(version, format.extension),
      );
      const exists = yield* fileSystem.exists(filePath).pipe(Effect.orElseSucceed(() => false));
      if (!exists) continue;
      return yield* HttpServerResponse.file(filePath, {
        status: 200,
        headers: { "Cache-Control": "private, max-age=31536000, immutable" },
      }).pipe(
        Effect.catch(() =>
          Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
        ),
      );
    }
    return HttpServerResponse.text("Not Found", { status: 404 });
  }),
);
