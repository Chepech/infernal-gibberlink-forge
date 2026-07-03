# Operations and Deployment

## Docker image

The Dockerfile uses three stages:

1. `deps`: installs Node dependencies.
2. `builder`: runs `npm run build` with Next.js standalone output.
3. `runner`: copies only standalone server assets, creates `/data/input`, and runs as an unprivileged user.

## Docker Compose

Start the app:

```bash
docker compose up --build
```

The default service mounts `./samples` as `/data/input:ro`.

To use a production folder, update the volume:

```yaml
volumes:
  - /srv/incoming-text:/data/input:ro
```

## Environment configuration

| Variable | Recommended production value |
| --- | --- |
| `NODE_ENV` | `production` |
| `GIBBERLINK_INPUT_DIR` | `/data/input` |
| `GIBBERLINK_ALLOWED_ROOTS` | `/data/input` |
| `GIBBERLINK_MAX_FILE_BYTES` | Tune to expected text size. Default `524288`. |
| `GIBBERLINK_MAX_FILES` | Tune to folder size. Default `250`. |
| `GIBBERLINK_MAX_DEPTH` | Default `6`. |
| `GIBBERLINK_MAX_WAV_TEXT_BYTES` | Default `786432`. |

Keep mounted volumes read-only unless a future feature explicitly requires writes.

## Healthcheck

`GET /api/health` returns:

```json
{
  "ok": true,
  "service": "infernal-gibberlink",
  "storage": "none",
  "externalServices": false,
  "time": "..."
}
```

No database or external dependency is checked because the app does not require one.

## Logging

Logs are emitted as JSON lines to stdout/stderr. A typical successful WAV event:

```json
{
  "ts": "2026-01-01T00:00:00.000Z",
  "level": "info",
  "service": "infernal-gibberlink",
  "event": "gibberlink.wav.generated",
  "requestId": "...",
  "payloadBytes": 1200,
  "packetBytes": 1213,
  "symbols": 1618,
  "durationSeconds": 39.177,
  "wavBytes": 3456014,
  "checksum": "..."
}
```

Recommended ingestion targets:

- Docker logging drivers.
- Grafana Loki.
- ELK/OpenSearch.
- Cloud provider container log collectors.

## Security checklist

- Set `GIBBERLINK_ALLOWED_ROOTS` narrowly.
- Mount input volumes read-only.
- Keep `GIBBERLINK_MAX_FILE_BYTES` and `GIBBERLINK_MAX_WAV_TEXT_BYTES` bounded.
- Run behind TLS if exposed beyond localhost.
- Do not add external service credentials; the app is designed to be offline.

## Scaling notes

The app performs CPU-bound WAV synthesis inside the Next.js process. For very large batches, increase CPU limits or reduce payload limits. The current design is stateless, so horizontal scaling is safe if each instance has access to the same mounted input folder.
