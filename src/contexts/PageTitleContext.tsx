'use client';

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

type PageTitleContextValue = {
  title: string;
  extras: ReactNode;
  setTitle: (title: string) => void;
  setExtras: (extras: ReactNode) => void;
};

const PageTitleContext = createContext<PageTitleContextValue | undefined>(undefined);

export function PageTitleProvider({ children }: { children: ReactNode }) {
  const [title, setTitleState] = useState('');
  const [extras, setExtrasState] = useState<ReactNode>(null);
  const setTitle = useCallback((next: string) => setTitleState(next), []);
  const setExtras = useCallback((next: ReactNode) => setExtrasState(next), []);
  return (
    <PageTitleContext.Provider value={{ title, extras, setTitle, setExtras }}>
      {children}
    </PageTitleContext.Provider>
  );
}

export function usePageTitle() {
  const ctx = useContext(PageTitleContext);
  if (!ctx) {
    throw new Error('usePageTitle must be used within a PageTitleProvider');
  }
  return ctx;
}
