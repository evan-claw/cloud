'use client';

import { useEffect, type ReactNode } from 'react';
import { usePageTitle } from '@/contexts/PageTitleContext';

/** Renders nothing. Sets the topbar page title and optional extras via context. */
export function SetPageTitle({ title, children }: { title: string; children?: ReactNode }) {
  const { setTitle, setExtras } = usePageTitle();
  useEffect(() => {
    setTitle(title);
    return () => setTitle('');
  }, [title, setTitle]);
  useEffect(() => {
    setExtras(children ?? null);
    return () => setExtras(null);
  }, [children, setExtras]);
  return null;
}
