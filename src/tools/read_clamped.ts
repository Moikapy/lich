/**
 * Stream an HTTP response body with a hard byte ceiling so callers never
 * buffer an entire oversized payload before clamping.
 */

export interface ClampedBody {
  text: string;
  bytes_read: number;
  truncated: boolean;
}

/** Reject when Content-Length alone already exceeds the byte budget. */
export function reject_oversized_content_length(response: Response, max_bytes: number): void {
  const raw = response.headers.get("content-length");
  if (raw === null) {
    return;
  }
  const declared = Number.parseInt(raw, 10);
  if (Number.isFinite(declared) === true && declared > max_bytes) {
    throw new Error(`body_too_large: content-length ${declared} exceeds ${max_bytes}`);
  }
}

/** Read up to `max_bytes` from the response, decoding as utf8; cancel early. */
export async function read_clamped_text(response: Response, max_bytes: number): Promise<ClampedBody> {
  reject_oversized_content_length(response, max_bytes);
  if (response.body === null) {
    const text = await response.text();
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > max_bytes) {
      return { text: text.slice(0, max_bytes), bytes_read: max_bytes, truncated: true };
    }
    return { text, bytes_read: bytes, truncated: false };
  }
  return read_stream(response.body.getReader(), max_bytes);
}

async function read_stream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  max_bytes: number,
): Promise<ClampedBody> {
  const chunks: Buffer[] = [];
  let bytes_read = 0;
  let truncated = false;
  while (bytes_read < max_bytes) {
    const { done, value } = await reader.read();
    if (done === true || value === undefined) break;
    const room = max_bytes - bytes_read;
    const take = value.byteLength > room ? value.subarray(0, room) : value;
    chunks.push(Buffer.from(take));
    bytes_read += take.byteLength;
    if (value.byteLength > room) {
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return { text: Buffer.concat(chunks).toString("utf8"), bytes_read, truncated };
}
