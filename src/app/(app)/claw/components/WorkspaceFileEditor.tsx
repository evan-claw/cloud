'use client';

import { useCallback } from 'react';
import { toast } from 'sonner';
import { useFileTree, useReadFile, type useKiloClawMutations } from '@/hooks/useKiloClaw';
import { FileEditorShell } from './FileEditorShell';
import { FileEditorPane, type FileSaveError } from './FileEditorPane';

type ClawMutations = ReturnType<typeof useKiloClawMutations>;

function UserFileEditorPane({
  filePath,
  enabled,
  mutations,
  onDirtyChange,
}: {
  filePath: string;
  enabled: boolean;
  mutations: ClawMutations;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { data, isLoading, error, refetch } = useReadFile(filePath, enabled);

  const handleSave = useCallback(
    (
      args: { path: string; content: string; etag?: string },
      callbacks: {
        onSuccess: (result: { etag: string }) => void;
        onError: (err: FileSaveError) => void;
      }
    ) => {
      if (!args.etag) return; // Save is disabled until file loads and ETag is set
      mutations.writeFile.mutate({ ...args, etag: args.etag }, callbacks);
    },
    [mutations.writeFile]
  );

  const validateBeforeSave = useCallback((path: string, content: string) => {
    if (path === 'openclaw.json') {
      try {
        const parsed = JSON.parse(content);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          toast.error('Config must be a JSON object');
          return false;
        }
      } catch {
        toast.error('Invalid JSON — fix syntax errors before saving');
        return false;
      }
    }
    return true;
  }, []);

  return (
    <FileEditorPane
      filePath={filePath}
      data={data}
      isLoading={isLoading}
      error={error}
      refetch={refetch}
      onSave={handleSave}
      isSaving={mutations.writeFile.isPending}
      onDirtyChange={onDirtyChange}
      validateBeforeSave={validateBeforeSave}
    />
  );
}

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

  return (
    <FileEditorShell
      tree={tree}
      isLoading={isLoading}
      error={error}
      refetch={refetch}
      onClose={() => onOpenChange(false)}
      renderPane={(selectedPath, onDirtyChange) => (
        <UserFileEditorPane
          key={selectedPath}
          filePath={selectedPath}
          enabled={enabled}
          mutations={mutations}
          onDirtyChange={onDirtyChange}
        />
      )}
    />
  );
}
