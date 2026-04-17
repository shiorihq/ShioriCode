export interface JsonRpcError {
  code?: number;
  message?: string;
}

export interface JsonRpcRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export function isServerRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.method === "string" &&
    (typeof candidate.id === "string" || typeof candidate.id === "number")
  );
}

export function isServerNotification(value: unknown): value is JsonRpcNotification {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.method === "string" && !("id" in candidate);
}

export function isResponse(value: unknown): value is JsonRpcResponse {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  const hasId = typeof candidate.id === "string" || typeof candidate.id === "number";
  const hasMethod = typeof candidate.method === "string";
  return hasId && !hasMethod;
}

export function readObject(value: unknown, key?: string): Record<string, unknown> | undefined {
  const target =
    key === undefined
      ? value
      : value && typeof value === "object"
        ? (value as Record<string, unknown>)[key]
        : undefined;

  if (!target || typeof target !== "object") {
    return undefined;
  }

  return target as Record<string, unknown>;
}

export function readArray(value: unknown, key?: string): unknown[] | undefined {
  const target =
    key === undefined
      ? value
      : value && typeof value === "object"
        ? (value as Record<string, unknown>)[key]
        : undefined;

  return Array.isArray(target) ? target : undefined;
}

export function readString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

export function readBoolean(value: unknown, key: string): boolean | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "boolean" ? candidate : undefined;
}
