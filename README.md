# Infernal Gibberlink Forge

A dockerized, offline web application that scans a local folder for `.txt` files and converts the selected text into audible **gibberlink**: a self-contained GLNK v1 packet encoded as audible frequency-shift-keyed tones. The UI shows the exact text being translated and renders a waveform/spectrum visualization of the resulting sound communication.

The application is intentionally self-contained:

- No external AI, translation, text-to-speech, or audio services.
- No database required for the core workflow.
- Local folder access is server-side and restricted to configured allowed roots.
- WAV audio is synthesized in the app process.
- UI supports English, Spanish, and Portuguese.
- Logs are structured JSON for production ingestion.

## Quick start with Docker Compose

```bash
docker compose up --build
```

Open <http://localhost:3000> and scan `/data/input`.

By default, Compose mounts `./samples` into `/data/input` read-only. To point the app at your own host folder, change the volume in `docker-compose.yml`:

```yaml
volumes:
  - /absolute/path/on/your/host:/data/input:ro
```

## Local development

```bash
npm install
npm run dev
```

Then open <http://localhost:3000>. In local development, the default folder is `./samples`.

Useful environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `GIBBERLINK_INPUT_DIR` | `./samples` locally, `/data/input` in Docker | Default folder shown in the UI. |
| `GIBBERLINK_ALLOWED_ROOTS` | Same as `GIBBERLINK_INPUT_DIR` | Comma-separated absolute roots the API may scan/read. |
| `GIBBERLINK_MAX_FILE_BYTES` | `524288` | Maximum size of an individual `.txt` file. |
| `GIBBERLINK_MAX_FILES` | `250` | Maximum files read from a scan/batch. |
| `GIBBERLINK_MAX_DEPTH` | `6` | Maximum recursive scan depth. |
| `GIBBERLINK_MAX_WAV_TEXT_BYTES` | `786432` | Maximum combined text payload for WAV synthesis. |

## Production build without Docker

```bash
npm run build
npm run start
```

For production containers, prefer the included Dockerfile because it uses Next.js standalone output and runs as an unprivileged user.

## How it works

1. The UI calls `/api/runtime` to discover the default folder, limits, and allowed roots.
2. The user enters a folder path inside the app/container filesystem.
3. `/api/folders/scan` recursively finds `.txt` files and rejects paths outside `GIBBERLINK_ALLOWED_ROOTS`.
4. The user selects files and clicks **Forge gibberlink**.
5. `/api/files/read` reads selected text files.
6. The browser frames the text into GLNK v1 packet metadata and renders the text preview plus waveform/spectrum.
7. `/api/gibberlink/wav` synthesizes the audible signal as a downloadable/playable WAV.

## Documentation

- [Architecture](./doc/architecture.md)
- [Gibberlink protocol](./doc/gibberlink-protocol.md)
- [Operations and deployment](./doc/operations.md)
- [Internationalization](./doc/i18n.md)

## API endpoints

| Endpoint | Method | Description |
| --- | --- | --- |
| `/api/health` | `GET` | Healthcheck used by the preview/runtime. |
| `/api/runtime` | `GET` | Returns folder defaults, limits, and allowed roots. |
| `/api/folders/scan?folder=/data/input` | `GET` | Scans for `.txt` files. |
| `/api/files/read` | `POST` | Reads selected paths: `{ "paths": ["/data/input/a.txt"] }`. |
| `/api/gibberlink/wav` | `POST` | Generates WAV audio: `{ "text": "..." }`. |

## Notes on local folder access

Browsers cannot directly grant arbitrary host filesystem access to a server-rendered Docker app. This app follows the production-safe container pattern: mount host folders into the container and let the server scan only configured allowed roots.

Example:

```bash
docker run --rm -p 3000:3000 \
  -e GIBBERLINK_INPUT_DIR=/data/input \
  -e GIBBERLINK_ALLOWED_ROOTS=/data/input \
  -v /host/text/folder:/data/input:ro \
  infernal-gibberlink
```

## Logging

Server routes emit newline-delimited JSON logs with fields such as `ts`, `level`, `service`, `event`, `requestId`, and endpoint-specific metrics. These logs are suitable for Docker logging drivers, Loki, ELK, or CloudWatch-style collectors.

## Storage

The current implementation does not require persistent storage. SQLite is therefore not included. If future features require job history or saved presets, add SQLite only for that storage boundary while keeping file scanning and audio synthesis independent.
