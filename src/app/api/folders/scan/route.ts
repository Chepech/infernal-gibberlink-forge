import { scanTextFiles, FileAccessError } from "@/lib/local-files";
import { createRequestContext, logError, logInfo } from "@/lib/logger";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const context = createRequestContext(request);
  const folder = request.nextUrl.searchParams.get("folder");

  try {
    const result = await scanTextFiles(folder);

    logInfo("folder.scan.completed", {
      ...context,
      folder: result.folder,
      files: result.files.length,
      skipped: result.skipped.length,
    });

    return Response.json(result, {
      headers: {
        "x-request-id": context.requestId,
      },
    });
  } catch (error) {
    const status = error instanceof FileAccessError ? error.status : 500;
    const code = error instanceof FileAccessError ? error.code : "scan_failed";
    const message = error instanceof Error ? error.message : "Folder scan failed.";

    logError("folder.scan.failed", error, {
      ...context,
      folder,
      status,
      code,
    });

    return Response.json(
      { error: { code, message } },
      {
        status,
        headers: {
          "x-request-id": context.requestId,
        },
      },
    );
  }
}
