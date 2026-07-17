import { Option } from "effect";
import { HttpServerRequest } from "effect/unstable/http";

export function isSecureAuthRequest(request: HttpServerRequest.HttpServerRequest): boolean {
  const forwardedProto = request.headers["x-forwarded-proto"];
  if (forwardedProto) {
    return forwardedProto.split(",")[0]?.trim().toLowerCase() === "https";
  }
  const url = HttpServerRequest.toURL(request);
  return Option.isSome(url) && url.value.protocol === "https:";
}

export function authClientMetadata(request: HttpServerRequest.HttpServerRequest, label?: string) {
  const forwardedFor = request.headers["x-forwarded-for"];
  const ip = forwardedFor ? forwardedFor.split(",")[0]?.trim() : undefined;
  return {
    label: label ?? undefined,
    userAgent: request.headers["user-agent"] ?? undefined,
    ip: ip || undefined,
  };
}
