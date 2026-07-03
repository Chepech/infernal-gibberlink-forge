import { readTextDocuments } from "@/lib/local-files";
import { createRequestContext, logError, logInfo } from "@/lib/logger";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

type ReadRequest = {
  paths?: unknown;
};

export async function POST(request: NextRequest) {
  const context = createRequestContext(request);

  try {
    const body = (await request.json()) as ReadRequest;
    const paths = Array.isArray(body.paths)
      ? body.paths.filter((value): value is string => typeof value === "string")
      : [];

    if (paths.length === 0) {
      return Response.json(
        { error: { code: "no_paths", message: "At least one file path is required." } },
        { status: 400, headers: { "x-request-id": context.requestId } },
      );
    }

    const result = await readTextDocuments(paths);

    logInfo("files.read.completed", {
      ...context,
      requested: paths.length,
      documents: result.documents.length,
      skipped: result.skipped.length,
      totalBytes: result.totalBytes,
    });

    return Response.json(result, {
      headers: {
        "x-request-id": context.requestId,
      },
    });
  } catch (error) {
    logError("files.read.failed", error, context);

    return Response.json(
      { error: { code: "read_failed", message: "Unable to read selected files." } },
      { status: 500, headers: { "x-request-id": context.requestId } },
    );
  }
}
