'use client';

import { useState, useCallback, useRef } from 'react';
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
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const hasUnsavedChangesRef = useRef(false);

  const handleSelect = useCallback(
    (path: string) => {
      if (path === selectedPath) return;
      if (hasUnsavedChangesRef.current) {
        setPendingPath(path);
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
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={() => void refetch()}
        >
          <RefreshCw className="mr-1 h-3 w-3" />
          Refresh tree
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={() => onOpenChange(false)}
        >
          Close
        </Button>
      </div>
      <div className="flex overflow-hidden rounded-md border" style={{ height: '520px' }}>
        <div className="w-[220px] shrink-0 overflow-y-auto border-r">
          <FileTree tree={tree} selectedPath={selectedPath} onSelect={handleSelect} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          {selectedPath ? (
            <FileEditorPane
              key={selectedPath}
              filePath={selectedPath}
              enabled={enabled}
              mutations={mutations}
              onDirtyChange={dirty => {
                hasUnsavedChangesRef.current = dirty;
              }}
            />
          ) : (
            <div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">
              Select a file to edit
            </div>
          )}
        </div>
      </div>

      <AlertDialog open={pendingPath !== null} onOpenChange={() => setPendingPath(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved changes</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes. Discard them and switch files?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                hasUnsavedChangesRef.current = false;
                setSelectedPath(pendingPath);
                setPendingPath(null);
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
