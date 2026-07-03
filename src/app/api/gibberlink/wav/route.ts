import {
  buildTonePlan,
  createWavBytes,
  encodeTextToGibberlink,
  synthesizeFloat32,
} from "@/lib/gibberlink/codec";
import { createRequestContext, logError, logInfo } from "@/lib/logger";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

type WavRequest = {
  text?: unknown;
};

const DEFAULT_MAX_WAV_TEXT_BYTES = 768 * 1024;

export async function POST(request: NextRequest) {
  const context = createRequestContext(request);

  try {
    const body = (await request.json()) as WavRequest;
    const text = typeof body.text === "string" ? body.text : "";
    const byteLength = new TextEncoder().encode(text).byteLength;
    const maxBytes = parseMaxBytes();

    if (!text) {
      return Response.json(
        { error: { code: "empty_text", message: "Text is required to synthesize audio." } },
        { status: 400, headers: { "x-request-id": context.requestId } },
      );
    }

    if (byteLength > maxBytes) {
      return Response.json(
        {
          error: {
            code: "text_too_large",
            message: `Text payload exceeds ${maxBytes} bytes.`,
          },
        },
        { status: 413, headers: { "x-request-id": context.requestId } },
      );
    }

    const packet = encodeTextToGibberlink(text);
    const plan = buildTonePlan(packet.symbols);
    const samples = synthesizeFloat32(plan);
    const wavBytes = createWavBytes(samples, plan.sampleRate);
    const wavBody = new ArrayBuffer(wavBytes.byteLength);
    new Uint8Array(wavBody).set(wavBytes);

    logInfo("gibberlink.wav.generated", {
      ...context,
      payloadBytes: packet.payloadByteLength,
      packetBytes: packet.packetByteLength,
      symbols: packet.symbols.length,
      durationSeconds: packet.durationSeconds,
      wavBytes: wavBytes.byteLength,
      checksum: packet.checksum,
    });

    return new Response(wavBody, {
      status: 200,
      headers: {
        "content-type": "audio/wav",
        "content-length": String(wavBytes.byteLength),
        "cache-control": "no-store",
        "x-request-id": context.requestId,
        "x-gibberlink-checksum": packet.checksum,
      },
    });
  } catch (error) {
    logError("gibberlink.wav.failed", error, context);

    return Response.json(
      { error: { code: "wav_failed", message: "Unable to synthesize gibberlink WAV." } },
      { status: 500, headers: { "x-request-id": context.requestId } },
    );
  }
}

function parseMaxBytes(): number {
  const parsed = Number.parseInt(process.env.GIBBERLINK_MAX_WAV_TEXT_BYTES ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_WAV_TEXT_BYTES;
}
