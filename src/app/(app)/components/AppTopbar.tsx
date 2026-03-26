'use client';

import { usePageTitle } from '@/contexts/PageTitleContext';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from '@/components/ui/breadcrumb';

export function AppTopbar() {
  const { title, icon, extras, hidden } = usePageTitle();

  if (hidden) return null;

  return (
    <header className="@container bg-background sticky top-0 z-10 h-14 shrink-0 border-b">
      {/* Sidebar trigger pinned to the left edge */}
      <div className="absolute left-4 top-0 z-10 flex h-14 items-center gap-2">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="h-4 @min-[1280px]:hidden" />
      </div>

      {/* Title container: centered on wide screens, flush with trigger on narrow */}
      {title && (
        <div className="mx-auto flex h-full w-full max-w-285 items-center gap-2 pl-16 pr-4 md:pr-6 @min-[1280px]:px-4 @min-[1280px]:md:px-6">
          {icon}
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>{title}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          {extras}
        </div>
      )}
    </header>
  );
}
