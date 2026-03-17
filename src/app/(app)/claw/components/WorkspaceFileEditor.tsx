'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { useFileTree, type useKiloClawMutations } from '@/hooks/useKiloClaw';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { FileTree } from './FileTree';
import { FileEditorPane } from './FileEditorPane';

type ClawMutations = ReturnType<typeof useKiloClawMutations>;

export function WorkspaceFileEditor({
  enabled,
  mutations,
  onOpenChange,
}: {
  enabled: boolean;
  mutations: ClawMutations;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: tree, isLoading, error, refetch } = useFileTree(enabled);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<
    { type: 'switch'; path: string } | { type: 'close' } | null
  >(null);
  const hasUnsavedChangesRef = useRef(false);
  const [sidebarWidth, setSidebarWidth] = useState(220);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      e.preventDefault();
      const newWidth = dragRef.current.startWidth + (e.clientX - dragRef.current.startX);
      setSidebarWidth(Math.min(Math.max(newWidth, 140), 500));
    };
    const handleMouseUp = () => {
      if (dragRef.current) {
        dragRef.current = null;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  const handleDirtyChange = useCallback((dirty: boolean) => {
    hasUnsavedChangesRef.current = dirty;
  }, []);

  const handleSelect = useCallback(
    (path: string) => {
      if (path === selectedPath) return;
      if (hasUnsavedChangesRef.current) {
        setPendingAction({ type: 'switch', path });
        return;
      }
      setSelectedPath(path);
    },
    [selectedPath]
  );

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-4">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-muted-foreground text-sm">Loading file tree...</span>
      </div>
    );
  }

  if (error) {
    return (
      <Alert className="my-2">
        <AlertDescription>
          {error instanceof Error ? error.message : 'Failed to load file tree'}
        </AlertDescription>
      </Alert>
    );
  }

  if (!tree) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => void refetch()}>
          <RefreshCw className="mr-1 h-3 w-3" />
          Refresh tree
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={() => {
            if (hasUnsavedChangesRef.current) {
              setPendingAction({ type: 'close' });
              return;
            }
            onOpenChange(false);
          }}
        >
          Close
        </Button>
      </div>
      <div className="flex overflow-hidden rounded-md border">
        <div className="shrink-0 overflow-y-auto" style={{ width: `${sidebarWidth}px` }}>
          <FileTree tree={tree} selectedPath={selectedPath} onSelect={handleSelect} />
        </div>
        <div
          className="before:bg-border hover:before:bg-border relative w-3 shrink-0 cursor-col-resize before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:content-['']"
          onMouseDown={e => {
            dragRef.current = { startX: e.clientX, startWidth: sidebarWidth };
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
          }}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          {selectedPath ? (
            <FileEditorPane
              key={selectedPath}
              filePath={selectedPath}
              enabled={enabled}
              mutations={mutations}
              onDirtyChange={handleDirtyChange}
            />
          ) : (
            <div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">
              Select a file to edit
            </div>
          )}
        </div>
      </div>

      <AlertDialog open={pendingAction !== null} onOpenChange={() => setPendingAction(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved changes</AlertDialogTitle>
            <AlertDialogDescription>You have unsaved changes. Discard them?</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                hasUnsavedChangesRef.current = false;
                if (pendingAction?.type === 'switch') {
                  setSelectedPath(pendingAction.path);
                } else if (pendingAction?.type === 'close') {
                  onOpenChange(false);
                }
                setPendingAction(null);
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
