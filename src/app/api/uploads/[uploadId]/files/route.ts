import {
  getUploadConfig,
  resolveUploadSession,
  writeUploadFile,
  updateManifest,
} from "@/lib/upload-manager";
import { FileAccessError } from "@/lib/local-files";
import { createRequestContext, logError, logInfo } from "@/lib/logger";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ uploadId: string }>;
};

type AcceptedFile = {
  name: string;
  storedName: string;
  sizeBytes: number;
};

type RejectedFile = {
  name: string;
  reason: string;
};

// ---------------------------------------------------------------------------
// POST /api/uploads/[uploadId]/files — upload files to session
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest, { params }: RouteContext) {
  const context = createRequestContext(request);
  const { uploadId } = await params;
  const config = getUploadConfig();

  try {
    const { sessionDir, manifest } = await resolveUploadSession(uploadId);

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return Response.json(
        { error: "invalid_form_data" },
        { status: 400, headers: { "x-request-id": context.requestId } },
      );
    }

    const fileEntries = formData.getAll("file");

    const accepted: AcceptedFile[] = [];
    const rejected: RejectedFile[] = [];

    let acceptedCount = 0;
    let acceptedBytes = 0;

    for (const entry of fileEntries) {
      if (!(entry instanceof File)) {
        rejected.push({ name: String(entry), reason: "not_a_file" });
        continue;
      }

      const file = entry;

      // Check max files limit.
      if (manifest.fileCount + acceptedCount >= config.maxFiles) {
        rejected.push({ name: file.name, reason: "max_files" });
        continue;
      }

      // Check individual file size.
      if (file.size > config.maxFileBytes) {
        rejected.push({ name: file.name, reason: "file_too_large" });
        continue;
      }

      // Check total bytes limit.
      if (manifest.totalBytes + acceptedBytes + file.size > config.maxTotalBytes) {
        rejected.push({ name: file.name, reason: "total_too_large" });
        continue;
      }

      // Convert to Buffer and write.
      try {
        const buffer = Buffer.from(await file.arrayBuffer());
        const { storedName, sizeBytes } = await writeUploadFile(sessionDir, file.name, buffer);
        accepted.push({ name: file.name, storedName, sizeBytes });
        acceptedCount += 1;
        acceptedBytes += sizeBytes;
      } catch (error) {
        const reason =
          error instanceof FileAccessError
            ? error.code
            : error instanceof Error
              ? error.message
              : "write_failed";
        rejected.push({ name: file.name, reason });
      }
    }

    // Update manifest with cumulative deltas from this request.
    if (acceptedCount > 0) {
      await updateManifest(sessionDir, { fileCount: acceptedCount, totalBytes: acceptedBytes });
    }

    logInfo("uploads.files.completed", {
      ...context,
      uploadId,
      accepted: accepted.length,
      rejected: rejected.length,
      acceptedBytes,
    });

    return Response.json(
      { accepted, rejected },
      { headers: { "x-request-id": context.requestId } },
    );
  } catch (error) {
    if (error instanceof FileAccessError) {
      logInfo("uploads.files.client_error", {
        ...context,
        uploadId,
        status: error.status,
        code: error.code,
      });
      return Response.json(
        { error: error.code },
        { status: error.status, headers: { "x-request-id": context.requestId } },
      );
    }

    logError("uploads.files.failed", error, { ...context, uploadId });
    return Response.json(
      { error: "internal_error" },
      { status: 500, headers: { "x-request-id": context.requestId } },
    );
  }
}
