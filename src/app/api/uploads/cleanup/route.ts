import { getUploadConfig, sweepExpiredSessions } from "@/lib/upload-manager";
import { createRequestContext, logError, logInfo } from "@/lib/logger";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// POST /api/uploads/cleanup — manual sweep of expired upload sessions
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const context = createRequestContext(request);

  try {
    const config = getUploadConfig();
    const deleted = await sweepExpiredSessions(config.uploadDir);

    logInfo("uploads.cleanup.completed", { ...context, count: deleted.length, deleted });

    return Response.json(
      { deleted, count: deleted.length },
      { headers: { "x-request-id": context.requestId } },
    );
  } catch (error) {
    logError("uploads.cleanup.failed", error, context);
    return Response.json(
      { error: "internal_error" },
      { status: 500, headers: { "x-request-id": context.requestId } },
    );
  }
}
