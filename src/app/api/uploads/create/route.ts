import { promises as fs } from "node:fs";
import {
  getUploadConfig,
  createUploadSession,
  countActiveSessionsForIp,
  sweepExpiredSessions,
} from "@/lib/upload-manager";
import { checkRateLimit } from "@/lib/rate-limit";
import { createRequestContext, logError, logInfo } from "@/lib/logger";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const context = createRequestContext(request);
  const config = getUploadConfig();

  const ip =
    request.headers.get("x-forwarded-for") ??
    request.headers.get("x-real-ip") ??
    "unknown";

  try {
    if (!checkRateLimit(ip, config.rateLimit, config.rateWindowMs)) {
      logInfo("uploads.create.rate_limited", { ...context, ip });
      return Response.json(
        { error: "rate_limited" },
        { status: 429, headers: { "x-request-id": context.requestId } },
      );
    }

    const activeSessions = await countActiveSessionsForIp(ip);
    if (activeSessions >= config.maxSessionsPerIp) {
      logInfo("uploads.create.max_sessions", { ...context, ip, activeSessions });
      return Response.json(
        { error: "uploadMaxSessions" },
        { status: 429, headers: { "x-request-id": context.requestId } },
      );
    }

    // Fire-and-forget sweep of expired sessions.
    void sweepExpiredSessions(config.uploadDir);

    await fs.mkdir(config.uploadDir, { recursive: true });

    const { uploadId, expiresAt } = await createUploadSession(ip);

    logInfo("uploads.create.completed", { ...context, ip, uploadId, expiresAt });

    return Response.json(
      {
        uploadId,
        expiresAt,
        limits: {
          maxFiles: config.maxFiles,
          maxTotalBytes: config.maxTotalBytes,
          maxFileBytes: config.maxFileBytes,
          allowedExtensions: [".txt", ".md", ".json", ".csv"],
        },
      },
      { status: 201, headers: { "x-request-id": context.requestId } },
    );
  } catch (error) {
    logError("uploads.create.failed", error, { ...context, ip });
    return Response.json(
      { error: "internal_error" },
      { status: 500, headers: { "x-request-id": context.requestId } },
    );
  }
}
