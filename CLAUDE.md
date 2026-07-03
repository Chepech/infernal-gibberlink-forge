# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
npm run dev         # Next.js dev server (http://localhost:3000)
npm run build       # Production standalone build
npm run start       # Start production server
npm run lint        # ESLint
npm run typecheck   # TypeScript strict check
```

Docker:
```bash
docker compose up --build    # Build and run with ./samples mounted at /data/input
docker compose up -d         # Detached mode
```

No test framework is configured. There are no test files.

## Architecture

**Infernal Gibberlink Forge** is a fully offline, dockerized Next.js 16 application that converts local `.txt` files into audible FSK-encoded WAV audio using a custom GLNK v1 protocol.

### Three-layer design

1. **UI Layer** (`src/components/infernal-translator.tsx`) — Single-page React client with locale switching (en/es/pt). Discovers config via `/api/runtime`, scans folders, reads files, and requests WAV synthesis.

2. **API Layer** (`src/app/api/`) — Next.js route handlers:
   - `GET /api/health` — healthcheck
   - `GET /api/runtime` — exposes environment config to client
   - `GET /api/folders/scan?folder=<path>` — lists `.txt` files under allowed roots
   - `POST /api/files/read` — reads file contents (body: `{ paths: [...] }`)
   - `POST /api/gibberlink/wav` — synthesizes WAV audio (body: `{ text: "..." }`)

3. **Library Layer** (`src/lib/`):
   - `gibberlink/codec.ts` — GLNK v1 protocol: CRC32, 6-bit symbol packing, FSK tone synthesis (44.1 kHz, 64 frequencies from 620–3518 Hz, 22ms symbols), 16-bit mono WAV encoding with harmonic timbre
   - `local-files.ts` — filesystem scanning with realpath validation against `GIBBERLINK_ALLOWED_ROOTS`, depth/size/count limits, `.txt`-only filtering
   - `logger.ts` — structured JSON logging to stdout with request correlation IDs

### Key design constraints

- **No external services** — all audio synthesis happens in-process
- **No database** — Drizzle/PostgreSQL config exists as template remnants but is unused; app is stateless
- **Security boundary** — all file paths validated via `fs.realpath` against comma-separated `GIBBERLINK_ALLOWED_ROOTS`; Docker mounts are read-only
- **Structured logging** — every request gets a correlation ID; logs are JSON for ingestion by Loki/ELK/CloudWatch

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `GIBBERLINK_INPUT_DIR` | `./samples` (local) / `/data/input` (Docker) | Default scan folder |
| `GIBBERLINK_ALLOWED_ROOTS` | same as INPUT_DIR | Comma-separated allowed scan roots |
| `GIBBERLINK_MAX_FILE_BYTES` | `524288` (512 KB) | Per-file size limit |
| `GIBBERLINK_MAX_FILES` | `250` | Max files per scan |
| `GIBBERLINK_MAX_DEPTH` | `6` | Max directory recursion |
| `GIBBERLINK_MAX_WAV_TEXT_BYTES` | `786432` (768 KB) | Max input text for WAV synthesis |

### i18n

Locales defined in `src/i18n/messages.ts` (en, es, pt) with type-safe `satisfies` constraint. Client detects locale from localStorage → browser language → English fallback. Only UI strings are translated; protocol constants, byte counts, and file paths remain locale-independent.

### GLNK v1 protocol summary

Packet: `GLNK` magic + version(1) + payload_length(4B) + CRC32(4B) + UTF-8 payload → 6-bit symbols → FSK tones (base 620 Hz, step 46 Hz, 64 symbols). Preamble: wake(1160 Hz) + two syncs + lock(880 Hz). Symbol timing: 22ms tone + 2ms gap.
