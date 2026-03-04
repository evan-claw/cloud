import { POST as openrouterPOST } from '@/app/api/openrouter/[...path]/route';
import type { NextRequest } from 'next/server';
import { FEATURE_HEADER } from '@/lib/feature-detection';

export function POST(request: NextRequest) {
  if (!request.headers.has(FEATURE_HEADER)) {
    request.headers.set(FEATURE_HEADER, 'direct-gateway');
  }
  return openrouterPOST(request);
}
