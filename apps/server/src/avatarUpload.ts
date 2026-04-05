import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { deleteUploadThingFileByUrl, uploadToUploadThing } from "./uploadthing";

const MAX_SIZE_BYTES = 10 * 1024 * 1024;

const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/heif",
]);

const sanitize = (name: string) => name.replace(/[^a-zA-Z0-9._-]/g, "_");

const withRandomSuffix = (name: string) => {
  const suffix = Math.random().toString(36).slice(-8);
  const lastDot = name.lastIndexOf(".");
  if (lastDot <= 0) return `${name}-${suffix}`;
  return `${name.slice(0, lastDot)}-${suffix}${name.slice(lastDot)}`;
};

function jsonResponse(body: unknown, status: number) {
  return HttpServerResponse.text(JSON.stringify(body), {
    status,
    contentType: "application/json",
  });
}

export const avatarUploadRouteLayer = HttpRouter.add(
  "POST",
  "/api/profile/avatar",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const webRequest = request.source as Request;

    const result = yield* Effect.promise(async () => {
      let formData: globalThis.FormData;
      try {
        formData = (await webRequest.formData()) as globalThis.FormData;
      } catch {
        return { ok: false as const, status: 400, error: "Invalid form data" };
      }

      const file = formData.get("file");
      if (!(file instanceof File)) {
        return { ok: false as const, status: 400, error: "No file provided" };
      }

      if (file.size > MAX_SIZE_BYTES) {
        return {
          ok: false as const,
          status: 400,
          error: "Profile pictures must be 10MB or smaller.",
        };
      }

      const detectedType = file.type;
      if (!detectedType.startsWith("image/") || !ALLOWED_MIME_TYPES.has(detectedType)) {
        return {
          ok: false as const,
          status: 400,
          error: "Profile pictures must be PNG, JPEG, WEBP, HEIC, or HEIF images.",
        };
      }

      const uniqueFilename = withRandomSuffix(sanitize(file.name));

      try {
        const upload = await uploadToUploadThing(file, {
          filename: uniqueFilename,
          contentType: detectedType,
        });
        return { ok: true as const, url: upload.url };
      } catch {
        return { ok: false as const, status: 500, error: "Failed to upload profile picture." };
      }
    });

    if (!result.ok) {
      return jsonResponse({ success: false, error: result.error }, result.status);
    }

    return jsonResponse({ success: true, data: { url: result.url } }, 200);
  }),
);

export const avatarDeleteRouteLayer = HttpRouter.add(
  "DELETE",
  "/api/profile/avatar",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const webRequest = request.source as Request;

    yield* Effect.promise(async () => {
      try {
        const body = (await webRequest.json()) as { url?: string };
        if (body.url) {
          await deleteUploadThingFileByUrl(body.url);
        }
      } catch {
        // Best-effort cleanup — ignore errors
      }
    });

    return jsonResponse({ success: true }, 200);
  }),
);
