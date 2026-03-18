// crypto.subtle.timingSafeEqual is a Cloudflare Workers extension not in the standard WebCrypto spec.
type SubtleCryptoWithTimingSafeEqual = SubtleCrypto & {
  timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean;
};

export async function timingSafeCompare(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const subtle = crypto.subtle satisfies SubtleCrypto as SubtleCryptoWithTimingSafeEqual;
  const [hashA, hashB] = await Promise.all([
    subtle.digest('SHA-256', encoder.encode(a)),
    subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  return subtle.timingSafeEqual(hashA, hashB);
}
