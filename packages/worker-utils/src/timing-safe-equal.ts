/**
 * Timing-safe string comparison.
 *
 * Uses crypto.subtle.timingSafeEqual when available (Cloudflare Workers),
 * falls back to a constant-time JS comparison for environments without it (Node.js / Next.js).
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);

  if (aBytes.length !== bBytes.length) {
    // Perform a dummy comparison so timing doesn't leak the length mismatch
    const dummy = new Uint8Array(aBytes.length);
    constantTimeCompare(aBytes, dummy);
    return false;
  }

  return constantTimeCompare(aBytes, bBytes);
}

/**
 * Constant-time byte comparison. Both arrays must be the same length.
 *
 * Prefers crypto.subtle.timingSafeEqual (Cloudflare Workers extension),
 * otherwise XORs every byte pair for a JS-only constant-time result.
 */
function constantTimeCompare(a: Uint8Array, b: Uint8Array): boolean {
  // Cloudflare Workers expose timingSafeEqual on crypto.subtle
  const subtle = crypto?.subtle as
    | (SubtleCrypto & {
        timingSafeEqual?: (
          a: ArrayBufferView | ArrayBuffer,
          b: ArrayBufferView | ArrayBuffer
        ) => boolean;
      })
    | undefined;

  if (typeof subtle?.timingSafeEqual === 'function') {
    return subtle.timingSafeEqual(a, b);
  }

  // JS fallback: XOR every byte, constant-time regardless of mismatch position
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}
