export const GIBBERLINK_PROTOCOL = {
  magic: "GLNK",
  version: 1,
  sampleRate: 44_100,
  baseFrequencyHz: 620,
  symbolStepHz: 46,
  symbolCount: 64,
  symbolDurationSeconds: 0.022,
  gapDurationSeconds: 0.002,
  preamble: [
    { frequencyHz: 1_160, durationSeconds: 0.11, label: "wake" },
    { frequencyHz: 1_920, durationSeconds: 0.08, label: "sync-a" },
    { frequencyHz: 2_680, durationSeconds: 0.08, label: "sync-b" },
    { frequencyHz: 880, durationSeconds: 0.075, label: "lock" },
  ],
} as const;

export type ToneEvent = {
  frequencyHz: number;
  durationSeconds: number;
  label: string;
  symbol?: number;
};

export type TonePlan = {
  sampleRate: number;
  events: ToneEvent[];
  durationSeconds: number;
  symbolCount: number;
};

export type GibberlinkPacket = {
  payloadByteLength: number;
  packetByteLength: number;
  checksum: string;
  symbols: number[];
  durationSeconds: number;
  protocol: typeof GIBBERLINK_PROTOCOL;
};

const encoder = new TextEncoder();

const CRC32_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint32BigEndian(target: Uint8Array, offset: number, value: number) {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function packSixBitSymbols(bytes: Uint8Array): number[] {
  const symbols: number[] = [];
  let accumulator = 0;
  let bitCount = 0;

  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bitCount += 8;

    while (bitCount >= 6) {
      const shift = bitCount - 6;
      symbols.push((accumulator >> shift) & 0x3f);
      bitCount -= 6;
      accumulator &= (1 << bitCount) - 1;
    }
  }

  if (bitCount > 0) {
    symbols.push((accumulator << (6 - bitCount)) & 0x3f);
  }

  return symbols;
}

export function encodeTextToGibberlink(text: string): GibberlinkPacket {
  const payload = encoder.encode(text);
  const checksumNumber = crc32(payload);
  const header = new Uint8Array(13);

  header[0] = GIBBERLINK_PROTOCOL.magic.charCodeAt(0);
  header[1] = GIBBERLINK_PROTOCOL.magic.charCodeAt(1);
  header[2] = GIBBERLINK_PROTOCOL.magic.charCodeAt(2);
  header[3] = GIBBERLINK_PROTOCOL.magic.charCodeAt(3);
  header[4] = GIBBERLINK_PROTOCOL.version;
  writeUint32BigEndian(header, 5, payload.byteLength);
  writeUint32BigEndian(header, 9, checksumNumber);

  const packet = new Uint8Array(header.byteLength + payload.byteLength);
  packet.set(header, 0);
  packet.set(payload, header.byteLength);

  const symbols = packSixBitSymbols(packet);
  const durationSeconds = estimateDurationSeconds(symbols.length);

  return {
    payloadByteLength: payload.byteLength,
    packetByteLength: packet.byteLength,
    checksum: checksumNumber.toString(16).padStart(8, "0"),
    symbols,
    durationSeconds,
    protocol: GIBBERLINK_PROTOCOL,
  };
}

export function estimateDurationSeconds(symbolCount: number): number {
  const preambleSeconds = GIBBERLINK_PROTOCOL.preamble.reduce(
    (total, event) => total + event.durationSeconds,
    0,
  );
  return (
    preambleSeconds +
    symbolCount *
      (GIBBERLINK_PROTOCOL.symbolDurationSeconds +
        GIBBERLINK_PROTOCOL.gapDurationSeconds)
  );
}

export function frequencyForSymbol(symbol: number): number {
  const clamped = Math.max(0, Math.min(GIBBERLINK_PROTOCOL.symbolCount - 1, symbol));
  return (
    GIBBERLINK_PROTOCOL.baseFrequencyHz +
    clamped * GIBBERLINK_PROTOCOL.symbolStepHz
  );
}

export function buildTonePlan(symbols: readonly number[]): TonePlan {
  const symbolEvents = symbols.map<ToneEvent>((symbol, index) => ({
    frequencyHz: frequencyForSymbol(symbol),
    durationSeconds: GIBBERLINK_PROTOCOL.symbolDurationSeconds,
    label: `symbol-${index.toString().padStart(5, "0")}`,
    symbol,
  }));

  const events = [
    ...GIBBERLINK_PROTOCOL.preamble.map<ToneEvent>((event) => ({
      frequencyHz: event.frequencyHz,
      durationSeconds: event.durationSeconds,
      label: `preamble-${event.label}`,
    })),
    ...symbolEvents,
  ];

  return {
    sampleRate: GIBBERLINK_PROTOCOL.sampleRate,
    events,
    durationSeconds: estimateDurationSeconds(symbols.length),
    symbolCount: symbols.length,
  };
}

export function synthesizeFloat32(plan: TonePlan): Float32Array {
  const sampleRate = plan.sampleRate;
  const totalSamples = Math.max(1, Math.ceil(plan.durationSeconds * sampleRate));
  const output = new Float32Array(totalSamples);
  let cursor = 0;

  for (const event of plan.events) {
    const eventSamples = Math.max(1, Math.floor(event.durationSeconds * sampleRate));
    const attackSamples = Math.max(1, Math.floor(eventSamples * 0.08));
    const releaseStart = Math.max(attackSamples, eventSamples - attackSamples);

    for (let sample = 0; sample < eventSamples && cursor + sample < output.length; sample += 1) {
      const time = sample / sampleRate;
      const attack = Math.min(1, sample / attackSamples);
      const release = sample >= releaseStart ? Math.max(0, (eventSamples - sample) / attackSamples) : 1;
      const envelope = Math.min(attack, release);
      const harmonic = Math.sin(Math.PI * 2 * event.frequencyHz * time);
      const growl = Math.sin(Math.PI * 2 * (event.frequencyHz * 0.5) * time) * 0.22;
      output[cursor + sample] = (harmonic + growl) * envelope * 0.54;
    }

    cursor += eventSamples;

    if (typeof event.symbol === "number") {
      cursor += Math.floor(GIBBERLINK_PROTOCOL.gapDurationSeconds * sampleRate);
    }
  }

  return output;
}

export function createWavBytes(
  samples: Float32Array,
  sampleRate: number = GIBBERLINK_PROTOCOL.sampleRate,
): Uint8Array {
  const bytesPerSample = 2;
  const channelCount = 1;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true);
  view.setUint16(32, channelCount * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += bytesPerSample;
  }

  return new Uint8Array(buffer);
}

function writeAscii(view: DataView, offset: number, text: string) {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}
