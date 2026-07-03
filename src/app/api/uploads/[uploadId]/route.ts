import { promises as fs } from "node:fs";
import path from "node:path";
import {
  getUploadConfig,
  resolveUploadSession,
  deleteUploadSession,
} from "@/lib/upload-manager";
import { FileAccessError, isAllowedUploadFile } from "@/lib/local-files";
import { createRequestContext, logError, logInfo } from "@/lib/logger";
import type { NextRequest } from "next/server";
import type { LocalTextFile } from "@/lib/local-files";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ uploadId: string }>;
};

// ---------------------------------------------------------------------------
// GET /api/uploads/[uploadId] — list files in session
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest, { params }: RouteContext) {
  const context = createRequestContext(request);
  const { uploadId } = await params;
  const config = getUploadConfig();

  try {
    const { sessionDir, manifest } = await resolveUploadSession(uploadId);

    // Scan the flat session directory for all allowed upload extensions.
    const files: LocalTextFile[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];

    const entries = await fs.readdir(sessionDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        // Skip hidden files including the manifest.
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const fullPath = path.join(sessionDir, entry.name);

      if (!isAllowedUploadFile(entry.name)) {
        skipped.push({ path: entry.name, reason: "not_allowed" });
        continue;
      }

      const stat = await fs.stat(fullPath);

      if (stat.size > config.maxFileBytes) {
        skipped.push({ path: entry.name, reason: "file_too_large" });
        continue;
      }

      if (files.length >= config.maxFiles) {
        skipped.push({ path: entry.name, reason: "max_files" });
        continue;
      }

      files.push({
        path: fullPath,
        relativePath: entry.name,
        name: entry.name,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
    }

    files.sort((a, b) => a.name.localeCompare(b.name));

    logInfo("uploads.list.completed", {
      ...context,
      uploadId,
      files: files.length,
      skipped: skipped.length,
    });

    return Response.json(
      {
        uploadId,
        folder: sessionDir,
        expiresAt: manifest.expiresAt,
        files,
        skipped,
        limits: {
          maxFiles: config.maxFiles,
          maxTotalBytes: config.maxTotalBytes,
          maxFileBytes: config.maxFileBytes,
          allowedExtensions: [".txt", ".md", ".json", ".csv"],
        },
      },
      { headers: { "x-request-id": context.requestId } },
    );
  } catch (error) {
    if (error instanceof FileAccessError) {
      logInfo("uploads.list.client_error", {
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

    logError("uploads.list.failed", error, { ...context, uploadId });
    return Response.json(
      { error: "internal_error" },
      { status: 500, headers: { "x-request-id": context.requestId } },
    );
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/uploads/[uploadId] — delete session
// ---------------------------------------------------------------------------

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const context = createRequestContext(request);
  const { uploadId } = await params;

  try {
    const { sessionDir } = await resolveUploadSession(uploadId);

    await deleteUploadSession(sessionDir);

    logInfo("uploads.delete.completed", { ...context, uploadId });

    return new Response(null, {
      status: 204,
      headers: { "x-request-id": context.requestId },
    });
  } catch (error) {
    if (error instanceof FileAccessError) {
      logInfo("uploads.delete.client_error", {
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

    logError("uploads.delete.failed", error, { ...context, uploadId });
    return Response.json(
      { error: "internal_error" },
      { status: 500, headers: { "x-request-id": context.requestId } },
    );
  }
}
