/**
 * @fileoverview Bounded response-body reader for error diagnostics.
 * @module src/utils/network/responseBody
 */

export interface BoundedText {
  text: string;
  truncated: boolean;
}

function decodeUtf8Prefix(bytes: Uint8Array): string {
  // A byte cap can split the final UTF-8 code point. Trim at most the maximum
  // UTF-8 continuation width so a valid body never grows a replacement marker
  // beyond the requested diagnostic budget.
  const minimum = Math.max(0, bytes.byteLength - 3);
  for (let end = bytes.byteLength; end >= minimum; end -= 1) {
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
        bytes.subarray(0, end),
      );
    } catch {
      // Try the preceding byte boundary.
    }
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Reads at most `maxBytes` from a response body, then cancels the stream.
 * This is intentionally destructive: callers use it only for non-success
 * responses that will be converted into an error.
 */
export async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
): Promise<BoundedText> {
  const limit = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : 0;
  if (!response.body) {
    return { text: await response.text(), truncated: false };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  // Keep reading until the limit is exceeded, not merely reached, so a body of
  // exactly `limit` bytes is reported whole rather than marked truncated.
  let read = 0;

  while (read <= limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    read += value.byteLength;
  }

  const truncated = read > limit;
  if (truncated) {
    try {
      await reader.cancel('Response body diagnostic limit reached');
    } catch {
      // The bounded capture remains valid if the producer rejects cancellation.
    }
  }

  const captured = Math.min(read, limit);
  const bytes = new Uint8Array(captured);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= captured) break;
    const accepted = chunk.subarray(0, captured - offset);
    bytes.set(accepted, offset);
    offset += accepted.byteLength;
  }
  return { text: decodeUtf8Prefix(bytes), truncated };
}
