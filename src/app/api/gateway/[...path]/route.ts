import { POST as openrouterPOST } from '@/app/api/openrouter/[...path]/route';
import { NextRequest } from 'next/server';
import { FEATURE_HEADER } from '@/lib/feature-detection';

export function POST(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set(FEATURE_HEADER, 'direct-gateway');
  return openrouterPOST(new NextRequest(request, { headers }));
}
