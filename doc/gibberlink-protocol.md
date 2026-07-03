# Gibberlink Protocol

## Purpose

GLNK v1 is an offline audible encoding designed for this app. It converts UTF-8 text into a packet and maps that packet to audible frequency-shift-keyed tones. It is inspired by machine-to-machine acoustic communication patterns, but it does not rely on external services or proprietary codecs.

## Packet structure

Each forged message starts as a byte packet:

| Offset | Size | Field | Description |
| --- | ---: | --- | --- |
| `0` | 4 | Magic | ASCII `GLNK`. |
| `4` | 1 | Version | Current value: `1`. |
| `5` | 4 | Payload length | Big-endian UTF-8 byte length. |
| `9` | 4 | CRC32 | Big-endian CRC32 of the payload. |
| `13` | N | Payload | UTF-8 text corpus. |

Multiple files are combined into a corpus with explicit file boundary markers before packetization.

## Symbol packing

The packet bytes are packed into 6-bit symbols. Each symbol is an integer from `0` to `63`.

- 6-bit packing keeps the tone alphabet compact.
- Padding bits are zero-filled at the end of the stream.
- The payload length and CRC32 allow a decoder to identify the exact payload boundary.

## Acoustic mapping

| Setting | Value |
| --- | ---: |
| Sample rate | `44100 Hz` |
| Symbol count | `64` |
| Base frequency | `620 Hz` |
| Frequency step | `46 Hz` |
| Highest symbol frequency | `3518 Hz` |
| Symbol duration | `22 ms` |
| Gap after each data symbol | `2 ms` |

Frequency formula:

```text
frequency(symbol) = 620 + symbol * 46
```

The signal begins with four preamble tones:

1. `1160 Hz` wake tone for `110 ms`
2. `1920 Hz` sync tone for `80 ms`
3. `2680 Hz` sync tone for `80 ms`
4. `880 Hz` lock tone for `75 ms`

## WAV synthesis

The app synthesizes mono PCM WAV audio in-process:

- 16-bit signed samples.
- 44.1 kHz sample rate.
- Short attack/release envelope on each tone to reduce clicks.
- A subtle lower harmonic is mixed into each tone for a harsher industrial timbre while preserving the main symbol frequency.

## Decoding considerations

A future decoder can reverse the process:

1. Detect preamble tones.
2. Segment data symbols at `24 ms` intervals including gap.
3. Estimate the dominant frequency in each symbol window.
4. Map frequency back to the nearest symbol.
5. Unpack symbols to bytes.
6. Validate `GLNK`, version, payload length, and CRC32.

The current product requirement only asks for translation to audible gibberlink, playback/download, and visualization, so decoder UI is intentionally out of scope.
