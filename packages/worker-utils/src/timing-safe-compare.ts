import { timingSafeEqual } from 'crypto';

// Both inputs are hashed with SHA-256 so the comparison is always on equal-length
// digests, preventing length-leak side-channel attacks.
export async function timingSafeCompare(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  return timingSafeEqual(new Uint8Array(hashA), new Uint8Array(hashB));
}
