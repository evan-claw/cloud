import { describe, test, expect } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import { FEATURE_HEADER } from '@/lib/feature-detection';

jest.mock('@/app/api/openrouter/[...path]/route', () => ({
  POST: jest.fn(),
}));

import { POST as openrouterPOST } from '@/app/api/openrouter/[...path]/route';
import { POST } from './route';

const mockedOpenrouterPOST = jest.mocked(openrouterPOST);

describe('POST /api/gateway/[...path]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedOpenrouterPOST.mockResolvedValue(NextResponse.json({}, { status: 200 }));
  });

  test('sets x-kilocode-feature to direct-gateway', async () => {
    await POST(new NextRequest('http://localhost:3000/api/gateway/chat/completions'));

    const forwarded = mockedOpenrouterPOST.mock.calls[0][0];
    expect(forwarded.headers.get(FEATURE_HEADER)).toBe('direct-gateway');
  });

  test('does not overwrite a client-supplied x-kilocode-feature header', async () => {
    const request = new NextRequest('http://localhost:3000/api/gateway/chat/completions', {
      headers: { [FEATURE_HEADER]: 'vscode-extension' },
    });

    await POST(request);

    const forwarded = mockedOpenrouterPOST.mock.calls[0][0];
    expect(forwarded.headers.get(FEATURE_HEADER)).toBe('vscode-extension');
  });
});
