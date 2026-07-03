import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

type LogLevel = "debug" | "info" | "warn" | "error";

type LogFields = Record<string, unknown>;

export type RequestContext = {
  requestId: string;
  method?: string;
  path?: string;
  userAgent?: string | null;
};

export function createRequestContext(request?: NextRequest): RequestContext {
  const requestId =
    request?.headers.get("x-request-id") ??
    request?.headers.get("x-correlation-id") ??
    randomUUID();

  return {
    requestId,
    method: request?.method,
    path: request?.nextUrl.pathname,
    userAgent: request?.headers.get("user-agent"),
  };
}

export function logDebug(event: string, fields: LogFields = {}) {
  writeLog("debug", event, fields);
}

export function logInfo(event: string, fields: LogFields = {}) {
  writeLog("info", event, fields);
}

export function logWarn(event: string, fields: LogFields = {}) {
  writeLog("warn", event, fields);
}

export function logError(event: string, error: unknown, fields: LogFields = {}) {
  writeLog("error", event, {
    ...fields,
    error: serializeError(error),
  });
}

function writeLog(level: LogLevel, event: string, fields: LogFields) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    service: "infernal-gibberlink",
    event,
    ...fields,
  };

  const line = JSON.stringify(payload);

  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: process.env.NODE_ENV === "production" ? undefined : error.stack,
    };
  }

  return {
    message: String(error),
  };
}
