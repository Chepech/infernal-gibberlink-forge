/**
 * Upload session lifecycle manager for Infernal Gibberlink Forge.
 *
 * Each upload gets an isolated session directory under GIBBERLINK_UPLOAD_DIR.
 * A `.manifest.json` file inside the directory tracks metadata.  Sessions
 * expire after `ttlMs` milliseconds; the sweeper removes stale ones.
 */

import path from "node:path";
import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import { FileAccessError, isAllowedUploadFile } from "./local-files";
import { logInfo, logWarn, logError } from "./logger";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface UploadConfig {
  uploadDir: string;
  ttlMs: number;
  maxFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  rateLimit: number;
  rateWindowMs: number;
  maxSessionsPerIp: number;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getUploadConfig(): UploadConfig {
  const isDockerContext =
    process.env.GIBBERLINK_INPUT_DIR === "/data/input" ||
    path.resolve(process.env.GIBBERLINK_INPUT_DIR ?? "") === "/data/input";

  const uploadDir = path.resolve(
    process.env.GIBBERLINK_UPLOAD_DIR ??
      (isDockerContext ? "/data/uploads" : path.join(process.cwd(), "uploads")),
  );

  return {
    uploadDir,
    ttlMs: parsePositiveInt(process.env.GIBBERLINK_UPLOAD_TTL_MS, 3_600_000),
    maxFiles: parsePositiveInt(process.env.GIBBERLINK_UPLOAD_MAX_FILES, 50),
    maxTotalBytes: parsePositiveInt(
      process.env.GIBBERLINK_UPLOAD_MAX_TOTAL_BYTES,
      20_971_520,
    ),
    maxFileBytes: parsePositiveInt(process.env.GIBBERLINK_MAX_FILE_BYTES, 524_288),
    rateLimit: parsePositiveInt(process.env.GIBBERLINK_UPLOAD_RATE_LIMIT, 10),
    rateWindowMs: parsePositiveInt(process.env.GIBBERLINK_UPLOAD_RATE_WINDOW_MS, 600_000),
    maxSessionsPerIp: parsePositiveInt(
      process.env.GIBBERLINK_UPLOAD_MAX_SESSIONS_PER_IP,
      3,
    ),
  };
}

// ---------------------------------------------------------------------------
// Manifest type
// ---------------------------------------------------------------------------

interface SessionManifest {
  uploadId: string;
  createdAt: string;   // ISO 8601
  expiresAt: string;   // ISO 8601
  clientIp: string;
  fileCount: number;
  totalBytes: number;
}

const MANIFEST_NAME = ".manifest.json";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Validate that `candidatePath` is contained under `parentDir`. */
async function assertContainedUnder(candidatePath: string, parentDir: string): Promise<string> {
  let realParent: string;
  try {
    realParent = await fs.realpath(parentDir);
  } catch {
    realParent = path.resolve(parentDir);
  }

  let realCandidate: string;
  try {
    realCandidate = await fs.realpath(candidatePath);
  } catch {
    throw new FileAccessError("path_not_found", "The requested path does not exist.", 404);
  }

  const rel = path.relative(realParent, realCandidate);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    return realCandidate;
  }

  throw new FileAccessError(
    "path_not_allowed",
    "The requested path is outside the allowed directory.",
    403,
  );
}

const SESSION_ID_RE = /^ul_[0-9a-f]{8}$/;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new upload session directory and write its manifest.
 *
 * @throws Error if `uploadDir` does not exist (the caller must ensure it).
 */
export async function createUploadSession(
  clientIp: string,
): Promise<{ uploadId: string; sessionDir: string; expiresAt: string }> {
  const config = getUploadConfig();
  const uploadId = "ul_" + crypto.randomBytes(4).toString("hex");
  const sessionDir = path.join(config.uploadDir, uploadId);

  await fs.mkdir(sessionDir, { recursive: false });

  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.ttlMs).toISOString();

  const manifest: SessionManifest = {
    uploadId,
    createdAt: now.toISOString(),
    expiresAt,
    clientIp,
    fileCount: 0,
    totalBytes: 0,
  };

  await fs.writeFile(
    path.join(sessionDir, MANIFEST_NAME),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );

  logInfo("upload_session_created", { uploadId, clientIp, expiresAt });

  return { uploadId, sessionDir, expiresAt };
}

/**
 * Resolve and validate an upload session by ID.
 *
 * @throws FileAccessError (404) if session directory / manifest is missing.
 * @throws FileAccessError (410) if the session has expired.
 */
export async function resolveUploadSession(
  uploadId: string,
): Promise<{ sessionDir: string; manifest: SessionManifest }> {
  if (!SESSION_ID_RE.test(uploadId)) {
    throw new FileAccessError("invalid_upload_id", "Invalid upload session ID format.", 400);
  }

  const config = getUploadConfig();
  const candidateDir = path.join(config.uploadDir, uploadId);

  // Containment check — also verifies the directory exists.
  let sessionDir: string;
  try {
    sessionDir = await assertContainedUnder(candidateDir, config.uploadDir);
  } catch (err) {
    if (err instanceof FileAccessError && err.code === "path_not_found") {
      throw new FileAccessError("session_not_found", "Upload session not found.", 404);
    }
    throw err;
  }

  // Read manifest.
  let manifest: SessionManifest;
  try {
    const raw = await fs.readFile(path.join(sessionDir, MANIFEST_NAME), "utf8");
    manifest = JSON.parse(raw) as SessionManifest;
  } catch {
    throw new FileAccessError("session_not_found", "Upload session not found.", 404);
  }

  // Expiry check.
  if (new Date(manifest.expiresAt).getTime() <= Date.now()) {
    logWarn("upload_session_expired", { uploadId });
    const expiredErr = new FileAccessError(
      "session_expired",
      "Upload session has expired.",
      410,
    );
    throw expiredErr;
  }

  return { sessionDir, manifest };
}

/**
 * Write an uploaded file into `sessionDir` with a sanitised, collision-safe name.
 *
 * Checks:
 *  - Extension must be in the allowed upload set (.txt, .md, .json, .csv).
 *  - The first 512 bytes must be valid UTF-8 (magic-byte / binary rejection).
 *  - Final path must be contained under `sessionDir`.
 */
export async function writeUploadFile(
  sessionDir: string,
  originalName: string,
  buffer: Buffer,
): Promise<{ storedName: string; sizeBytes: number }> {
  const basename = path.basename(originalName);
  const ext = path.extname(basename).toLowerCase();
  const stemRaw = path.basename(basename, ext).toLowerCase();

  // Strip disallowed characters and truncate.
  const stem = stemRaw.replace(/[^a-z0-9._-]/g, "").slice(0, 64) || "file";

  // Extension allowlist check.
  if (!isAllowedUploadFile(basename)) {
    throw new FileAccessError(
      "disallowed_extension",
      `File extension "${ext}" is not allowed for upload.`,
      415,
    );
  }

  // Magic-byte / UTF-8 validation: reject binary content.
  try {
    const probe = buffer.slice(0, 512);
    new TextDecoder("utf-8", { fatal: true }).decode(probe);
  } catch {
    throw new FileAccessError(
      "binary_content",
      "Uploaded file does not appear to be valid UTF-8 text.",
      415,
    );
  }

  const suffix = crypto.randomBytes(4).toString("hex");
  const storedName = `${stem}_${suffix}${ext}`;
  const finalPath = path.join(sessionDir, storedName);

  // Containment check before writing.
  const realSession = await (async () => {
    try {
      return await fs.realpath(sessionDir);
    } catch {
      return path.resolve(sessionDir);
    }
  })();
  const resolvedFinal = path.resolve(finalPath);
  const rel = path.relative(realSession, resolvedFinal);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new FileAccessError(
      "path_not_allowed",
      "Resolved file path escapes the session directory.",
      403,
    );
  }

  await fs.writeFile(finalPath, buffer);

  logInfo("upload_file_written", { sessionDir, storedName, sizeBytes: buffer.length });

  return { storedName, sizeBytes: buffer.length };
}

/**
 * Atomically update the manifest with cumulative file count / byte deltas.
 */
export async function updateManifest(
  sessionDir: string,
  delta: { fileCount: number; totalBytes: number },
): Promise<void> {
  const manifestPath = path.join(sessionDir, MANIFEST_NAME);
  const raw = await fs.readFile(manifestPath, "utf8");
  const manifest = JSON.parse(raw) as SessionManifest;

  manifest.fileCount += delta.fileCount;
  manifest.totalBytes += delta.totalBytes;

  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
}

/**
 * Delete an upload session directory after verifying containment under `uploadDir`.
 */
export async function deleteUploadSession(sessionDir: string): Promise<void> {
  const config = getUploadConfig();

  // Verify path is under uploadDir before deleting.
  const realUploadDir = await (async () => {
    try {
      return await fs.realpath(config.uploadDir);
    } catch {
      return path.resolve(config.uploadDir);
    }
  })();
  const realSession = await (async () => {
    try {
      return await fs.realpath(sessionDir);
    } catch {
      return path.resolve(sessionDir);
    }
  })();
  const rel = path.relative(realUploadDir, realSession);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new FileAccessError(
      "path_not_allowed",
      "Session directory is outside the upload directory.",
      403,
    );
  }

  await fs.rm(sessionDir, { recursive: true, force: true });
  logInfo("upload_session_deleted", { sessionDir });
}

/**
 * Scan all session directories under `uploadDir`, delete those whose
 * manifests indicate expiry, and return the list of deleted uploadIds.
 */
export async function sweepExpiredSessions(uploadDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(uploadDir);
  } catch {
    logWarn("sweep_upload_dir_unreadable", { uploadDir });
    return [];
  }

  const deleted: string[] = [];

  for (const entry of entries) {
    const sessionDir = path.join(uploadDir, entry);
    const manifestPath = path.join(sessionDir, MANIFEST_NAME);

    let manifest: SessionManifest;
    try {
      const raw = await fs.readFile(manifestPath, "utf8");
      manifest = JSON.parse(raw) as SessionManifest;
    } catch {
      // Not a valid session directory — skip.
      continue;
    }

    if (new Date(manifest.expiresAt).getTime() <= Date.now()) {
      try {
        await fs.rm(sessionDir, { recursive: true, force: true });
        deleted.push(manifest.uploadId);
        logInfo("upload_session_swept", { uploadId: manifest.uploadId });
      } catch (err) {
        logError("upload_session_sweep_failed", err, { uploadId: manifest.uploadId });
      }
    }
  }

  return deleted;
}

/**
 * Count non-expired upload sessions in `uploadDir` that belong to `ip`.
 */
export async function countActiveSessionsForIp(ip: string): Promise<number> {
  const config = getUploadConfig();
  let entries: string[];
  try {
    entries = await fs.readdir(config.uploadDir);
  } catch {
    return 0;
  }

  const now = Date.now();
  let count = 0;

  for (const entry of entries) {
    const manifestPath = path.join(config.uploadDir, entry, MANIFEST_NAME);
    try {
      const raw = await fs.readFile(manifestPath, "utf8");
      const manifest = JSON.parse(raw) as SessionManifest;
      if (
        manifest.clientIp === ip &&
        new Date(manifest.expiresAt).getTime() > now
      ) {
        count += 1;
      }
    } catch {
      // Ignore unreadable entries.
    }
  }

  return count;
}
