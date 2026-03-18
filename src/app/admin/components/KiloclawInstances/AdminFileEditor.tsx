'use client';

import { useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { FileEditorShell } from '@/app/(app)/claw/components/FileEditorShell';
import { FileEditorPane, type FileSaveError } from '@/app/(app)/claw/components/FileEditorPane';
import { validateOpenclawJsonForSave } from '@/app/(app)/claw/components/validateOpenclawJson';

function AdminFileEditorPaneInner({
  userId,
  filePath,
  writeFileMutation,
  onDirtyChange,
}: {
  userId: string;
  filePath: string;
  writeFileMutation: ReturnType<typeof useMutation<{ etag: string }, any, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  onDirtyChange: (dirty: boolean) => void;
}) {
  const trpc = useTRPC();
  const { data, isLoading, error, refetch } = useQuery(
    trpc.admin.kiloclawInstances.readFile.queryOptions(
      { userId, path: filePath },
      { refetchOnWindowFocus: false, refetchOnMount: 'always' }
    )
  );

  const handleSave = useCallback(
    (
      args: { path: string; content: string; etag?: string },
      callbacks: {
        onSuccess: (result: { etag: string }) => void;
        onError: (err: FileSaveError) => void;
      }
    ) => {
      writeFileMutation.mutate(
        { userId, path: args.path, content: args.content, etag: args.etag },
        callbacks
      );
    },
    [writeFileMutation, userId]
  );

  const validateBeforeSave = useCallback(validateOpenclawJsonForSave, []);

  return (
    <FileEditorPane
      filePath={filePath}
      data={data}
      isLoading={isLoading}
      error={error}
      refetch={refetch}
      onSave={handleSave}
      isSaving={writeFileMutation.isPending}
      onDirtyChange={onDirtyChange}
      validateBeforeSave={validateBeforeSave}
    />
  );
}

export function AdminFileEditor({ userId }: { userId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const {
    data: tree,
    isLoading,
    error,
    refetch,
  } = useQuery(
    trpc.admin.kiloclawInstances.fileTree.queryOptions({ userId }, { refetchOnWindowFocus: false })
  );

  const writeFileMutation = useMutation(
    trpc.admin.kiloclawInstances.writeFile.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.admin.kiloclawInstances.fileTree.queryKey({ userId }),
        });
        await queryClient.invalidateQueries({
          queryKey: trpc.admin.kiloclawInstances.readFile.queryKey(),
        });
      },
    })
  );

  return (
    <FileEditorShell
      tree={tree}
      isLoading={isLoading}
      error={error}
      refetch={refetch}
      height="600px"
      renderPane={(selectedPath, onDirtyChange) => (
        <AdminFileEditorPaneInner
          key={selectedPath}
          userId={userId}
          filePath={selectedPath}
          writeFileMutation={writeFileMutation}
          onDirtyChange={onDirtyChange}
        />
      )}
    />
  );
}
