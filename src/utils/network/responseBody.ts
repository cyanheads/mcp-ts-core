/**
 * @fileoverview Bounded response-body reader for error diagnostics.
 * @module src/utils/network/responseBody
 */

/** Share of the capture budget spent on the head of an over-budget body. */
const HEAD_SHARE = 0.4;

/** Options for {@link readBoundedResponseText}. */
export interface BoundedReadOptions {
  /**
   * Hard ceiling on the bytes pulled off the wire. Defaults to `maxBytes`, which
   * keeps the capture head-only: the reader stops as soon as the budget is
   * exceeded and never sees the end of the document.
   *
   * Raising it above `maxBytes` lets the reader reach the end of a document it
   * is not going to keep whole. A body that finishes within the ceiling is then
   * captured as head + tail around an elision marker, so a diagnostic sitting
   * behind a boilerplate preamble (doctype, stylesheet link, page header)
   * survives the cap. A body still streaming at the ceiling falls back to
   * head-only, because its real tail was never read.
   */
  scanBytes?: number;
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

/** Mirror of {@link decodeUtf8Prefix} for a slice taken from the end of a body. */
function decodeUtf8Suffix(bytes: Uint8Array): string {
  const maximum = Math.min(3, bytes.byteLength);
  for (let start = 0; start <= maximum; start += 1) {
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
        bytes.subarray(start),
      );
    } catch {
      // Drop the leading continuation byte and try the next boundary.
    }
  }
  return new TextDecoder().decode(bytes);
}

function positiveOrZero(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/**
 * Reads a response body under a byte budget and returns display-ready
 * diagnostic text — elision markers included, so callers append nothing.
 * At most `maxBytes` of body content is retained; the stream is cancelled once
 * the scan ceiling is passed.
 *
 * This is intentionally destructive: callers use it only for responses that
 * will be converted into an error.
 *
 * @param response - The response whose body is captured (consumed).
 * @param maxBytes - Body bytes retained in the returned text.
 * @param options - See {@link BoundedReadOptions.scanBytes} for head+tail capture.
 */
export async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
  options: BoundedReadOptions = {},
): Promise<string> {
  const limit = positiveOrZero(maxBytes);
  const scan = Math.max(limit, positiveOrZero(options.scanBytes));
  if (!response.body) {
    return await response.text();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  // Keep reading until the ceiling is exceeded, not merely reached, so a body of
  // exactly `scan` bytes is known to be whole rather than assumed truncated.
  let read = 0;

  while (read <= scan) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    read += value.byteLength;
  }

  const stillStreaming = read > scan;
  if (stillStreaming) {
    try {
      await reader.cancel('Response body diagnostic limit reached');
    } catch {
      // The bounded capture remains valid if the producer rejects cancellation.
    }
  }

  const captured = Math.min(read, scan);
  const bytes = new Uint8Array(captured);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= captured) break;
    const accepted = chunk.subarray(0, captured - offset);
    bytes.set(accepted, offset);
    offset += accepted.byteLength;
  }

  if (read <= limit) return decodeUtf8Prefix(bytes);

  // The tail was never read — keep the head and say so.
  if (stillStreaming) return `${decodeUtf8Prefix(bytes.subarray(0, limit))}…`;

  // The whole document was read and is over budget: keep both ends, since the
  // opening bytes are the least informative part of a wrapped error document.
  const head = Math.floor(limit * HEAD_SHARE);
  const tail = limit - head;
  const elided = captured - limit;
  return [
    decodeUtf8Prefix(bytes.subarray(0, head)),
    `…[${elided} byte${elided === 1 ? '' : 's'} elided]…`,
    decodeUtf8Suffix(bytes.subarray(captured - tail)),
  ].join('');
}
