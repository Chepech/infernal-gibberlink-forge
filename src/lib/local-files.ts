import path from "node:path";
import { promises as fs } from "node:fs";

export type LocalTextFile = {
  path: string;
  relativePath: string;
  name: string;
  sizeBytes: number;
  modifiedAt: string;
};

export type SkippedFile = {
  path: string;
  reason: string;
};

export type TextDocument = LocalTextFile & {
  content: string;
  lineCount: number;
};

export type RuntimeFileConfig = {
  defaultFolder: string;
  allowedRoots: string[];
  maxFileBytes: number;
  maxFiles: number;
  maxDepth: number;
};

export class FileAccessError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "FileAccessError";
    this.code = code;
    this.status = status;
  }
}

const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_FILES = 250;
const DEFAULT_MAX_DEPTH = 6;

export function getRuntimeFileConfig(): RuntimeFileConfig {
  const defaultFolder = path.resolve(
    process.env.GIBBERLINK_INPUT_DIR ?? path.join(process.cwd(), "samples"),
  );

  const configuredRoots = process.env.GIBBERLINK_ALLOWED_ROOTS
    ?.split(",")
    .map((root) => root.trim())
    .filter(Boolean);

  const allowedRoots = (configuredRoots?.length ? configuredRoots : [defaultFolder]).map((root) =>
    path.resolve(root),
  );

  return {
    defaultFolder,
    allowedRoots,
    maxFileBytes: parsePositiveInt(process.env.GIBBERLINK_MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES),
    maxFiles: parsePositiveInt(process.env.GIBBERLINK_MAX_FILES, DEFAULT_MAX_FILES),
    maxDepth: parsePositiveInt(process.env.GIBBERLINK_MAX_DEPTH, DEFAULT_MAX_DEPTH),
  };
}

export async function scanTextFiles(folderInput?: string | null) {
  const config = getRuntimeFileConfig();
  const folder = await resolveAllowedPath(folderInput || config.defaultFolder, config);
  const stat = await fs.stat(folder);

  if (!stat.isDirectory()) {
    throw new FileAccessError("not_directory", "The configured path is not a directory.", 400);
  }

  const files: LocalTextFile[] = [];
  const skipped: SkippedFile[] = [];

  await walkFolder({
    root: folder,
    current: folder,
    depth: 0,
    config,
    files,
    skipped,
  });

  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  return {
    folder,
    files,
    skipped,
    limits: {
      maxFileBytes: config.maxFileBytes,
      maxFiles: config.maxFiles,
      maxDepth: config.maxDepth,
    },
  };
}

export async function readTextDocuments(paths: string[]) {
  const config = getRuntimeFileConfig();
  const documents: TextDocument[] = [];
  const skipped: SkippedFile[] = [];

  for (const fileInput of paths.slice(0, config.maxFiles)) {
    try {
      const filePath = await resolveAllowedPath(fileInput, config);
      const stat = await fs.stat(filePath);

      if (!stat.isFile()) {
        skipped.push({ path: fileInput, reason: "not_file" });
        continue;
      }

      if (!isTextFile(filePath)) {
        skipped.push({ path: fileInput, reason: "not_txt" });
        continue;
      }

      if (stat.size > config.maxFileBytes) {
        skipped.push({ path: fileInput, reason: "file_too_large" });
        continue;
      }

      const content = (await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, "");
      documents.push({
        path: filePath,
        relativePath: await createDisplayRelativePath(filePath, config),
        name: path.basename(filePath),
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        content,
        lineCount: content.length === 0 ? 0 : content.split(/\r\n|\r|\n/).length,
      });
    } catch (error) {
      skipped.push({
        path: fileInput,
        reason: error instanceof FileAccessError ? error.code : "read_failed",
      });
    }
  }

  return {
    documents,
    skipped,
    totalBytes: documents.reduce((total, document) => total + document.sizeBytes, 0),
  };
}

async function walkFolder(options: {
  root: string;
  current: string;
  depth: number;
  config: RuntimeFileConfig;
  files: LocalTextFile[];
  skipped: SkippedFile[];
}) {
  const { root, current, depth, config, files, skipped } = options;

  if (files.length >= config.maxFiles) {
    return;
  }

  if (depth > config.maxDepth) {
    skipped.push({ path: current, reason: "max_depth" });
    return;
  }

  const entries = await fs.readdir(current, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const fullPath = path.join(current, entry.name);

    if (entry.isDirectory()) {
      await walkFolder({ ...options, current: fullPath, depth: depth + 1 });
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!isTextFile(fullPath)) {
      skipped.push({ path: path.relative(root, fullPath), reason: "not_txt" });
      continue;
    }

    const stat = await fs.stat(fullPath);

    if (stat.size > config.maxFileBytes) {
      skipped.push({ path: path.relative(root, fullPath), reason: "file_too_large" });
      continue;
    }

    files.push({
      path: fullPath,
      relativePath: path.relative(root, fullPath) || path.basename(fullPath),
      name: entry.name,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    });

    if (files.length >= config.maxFiles) {
      skipped.push({ path: current, reason: "max_files" });
      return;
    }
  }
}

async function resolveAllowedPath(inputPath: string, config: RuntimeFileConfig): Promise<string> {
  const requestedPath = path.resolve(inputPath);

  let realRequestedPath: string;
  try {
    realRequestedPath = await fs.realpath(requestedPath);
  } catch {
    throw new FileAccessError("path_not_found", "The requested path does not exist.", 404);
  }

  const allowedRoots = await Promise.all(
    config.allowedRoots.map(async (root) => {
      try {
        return await fs.realpath(root);
      } catch {
        return path.resolve(root);
      }
    }),
  );

  const isAllowed = allowedRoots.some((root) => {
    const relative = path.relative(root, realRequestedPath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });

  if (!isAllowed) {
    throw new FileAccessError(
      "path_not_allowed",
      "The requested path is outside the configured allowed roots.",
      403,
    );
  }

  return realRequestedPath;
}

async function createDisplayRelativePath(filePath: string, config: RuntimeFileConfig): Promise<string> {
  const realFilePath = await fs.realpath(filePath);
  const roots = await Promise.all(
    config.allowedRoots.map(async (root) => {
      try {
        return await fs.realpath(root);
      } catch {
        return path.resolve(root);
      }
    }),
  );

  const root = roots.find((candidate) => {
    const relative = path.relative(candidate, realFilePath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });

  return root ? path.relative(root, realFilePath) || path.basename(realFilePath) : path.basename(realFilePath);
}

function isTextFile(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === ".txt";
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
