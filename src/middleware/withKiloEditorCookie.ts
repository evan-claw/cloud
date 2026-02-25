import type { NextFetchEvent } from 'next/server';
import type { MiddlewareFactory } from '@/middleware/types';
import { EDITOR_SOURCE_COOKIE_NAME } from '@/lib/editorSource.client';
import { cookies } from 'next/headers';
import type { NextMiddlewareWithAuth, NextRequestWithAuth } from 'next-auth/middleware';

export const withKiloEditorCookie: MiddlewareFactory = (nextMiddleware: NextMiddlewareWithAuth) => {
  return async (request: NextRequestWithAuth, nextFetchEvent: NextFetchEvent) => {
    if (request.nextUrl.searchParams.has('source')) {
      const cookieStore = await cookies();
      cookieStore.set({
        name: EDITOR_SOURCE_COOKIE_NAME,
        value: request.nextUrl.searchParams.get('source') as string,
        httpOnly: false,
        secure: process.env.NODE_ENV === 'production',
        path: '/',
      });
    }
    return await nextMiddleware(request, nextFetchEvent);
  };
};
