# Architecture

## Overview

Infernal Gibberlink Forge is a Next.js App Router application that converts local `.txt` files into audible gibberlink audio without external services.

The application has three primary layers:

1. **Browser UI**
   - Responsive death-metal/post-industrial interface.
   - Full UI internationalization via local dictionaries.
   - File selection, status display, text preview, and waveform visualization.
   - Calls internal APIs only.

2. **Next.js route handlers**
   - Runtime configuration discovery.
   - Safe local folder scanning and text-file reads.
   - Offline WAV synthesis.
   - Production JSON logs.

3. **Shared core libraries**
   - `src/lib/gibberlink/codec.ts`: GLNK packet framing, CRC32, FSK symbol mapping, waveform synthesis, WAV encoding.
   - `src/lib/local-files.ts`: allowed-root path validation, recursive scanning, TXT filtering, read limits.
   - `src/lib/logger.ts`: request-aware structured logging.

## Request flow

```text
Browser
  ├─ GET  /api/runtime
  ├─ GET  /api/folders/scan?folder=/data/input
  ├─ POST /api/files/read
  └─ POST /api/gibberlink/wav
          ↓
Next.js route handlers
          ↓
Local filesystem + offline codec
```

## Folder security model

The app does not let the UI read arbitrary host paths. Instead:

- Operators mount host folders into the container, normally at `/data/input`.
- `GIBBERLINK_ALLOWED_ROOTS` defines where scanning and reads are allowed.
- Every requested path is resolved with `fs.realpath` and compared against real allowed roots.
- Only `.txt` files are included.
- Hidden directories are skipped.
- File size, recursion depth, and batch file count are capped by environment variables.

## Rendering model

The landing page is a small server component that renders the client application. All interactive workflow state is in `src/components/infernal-translator.tsx`.

The waveform canvas renders a deterministic visual representation from the encoded symbols. Audio playback and download use `/api/gibberlink/wav`, which synthesizes a WAV file in-process.

## Storage decision

No database is necessary for the requested workflow. PostgreSQL/Drizzle files from the base template are not used by the app routes. SQLite should only be introduced if future requirements include persisted job history, per-user presets, or audit records.

## Deployment topology

Recommended production deployment:

```text
Host folder with TXT files
          ↓ bind mount read-only
Docker container: Next.js standalone server
          ↓ HTTP
User browser
```

The server runs as an unprivileged `nextjs` user in the final Docker stage.

## Observability

Every server route emits structured JSON logs. Example event names:

- `health.ok`
- `runtime.config.loaded`
- `folder.scan.completed`
- `folder.scan.failed`
- `files.read.completed`
- `gibberlink.wav.generated`
- `gibberlink.wav.failed`

These logs can be routed directly from stdout/stderr into the platform log pipeline.
