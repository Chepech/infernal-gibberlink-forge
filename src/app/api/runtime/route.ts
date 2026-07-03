import { getRuntimeFileConfig } from "@/lib/local-files";
import { createRequestContext, logInfo } from "@/lib/logger";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const context = createRequestContext(request);
  const config = getRuntimeFileConfig();

  logInfo("runtime.config.loaded", {
    ...context,
    defaultFolder: config.defaultFolder,
    allowedRoots: config.allowedRoots,
  });

  return Response.json(config, {
    headers: {
      "x-request-id": context.requestId,
    },
  });
}
