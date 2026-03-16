'use client';

import { Suspense, lazy, useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { useKiloClawMutations } from '@/hooks/useKiloClaw';
import { useKiloClawOpenclawConfig } from '@/hooks/useKiloClaw';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';

type ClawMutations = ReturnType<typeof useKiloClawMutations>;

const Editor = lazy(() => import('@monaco-editor/react'));
const DiffEditor = lazy(() =>
  import('@monaco-editor/react').then(mod => ({ default: mod.DiffEditor }))
);

function EditorLoading() {
  return (
    <div className="bg-muted flex min-h-[300px] items-center justify-center rounded-md border">
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading editor...
      </div>
    </div>
  );
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const EDITOR_OPTIONS = {
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  fontSize: 13,
  folding: true,
  wordWrap: 'on' as const,
  automaticLayout: true,
  tabSize: 2,
  padding: { top: 8, bottom: 8 },
  scrollbar: {
    vertical: 'auto' as const,
    horizontal: 'hidden' as const,
    verticalScrollbarSize: 8,
  },
};

export function OpenclawConfigEditor({
  enabled,
  mutations,
  onOpenChange,
}: {
  enabled: boolean;
  mutations: ClawMutations;
  onOpenChange: (open: boolean) => void;
}) {
  const { data, isLoading, error, refetch } = useKiloClawOpenclawConfig(enabled);

  const baseConfig = useMemo(
    () => (data ? JSON.stringify(data.openclawConfig, null, 2) : ''),
    [data]
  );

  const [isMounted, setIsMounted] = useState(false);
  const [editedConfig, setEditedConfig] = useState<string | null>(null);
  const initialEtagRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (data?.etag && initialEtagRef.current === undefined) {
      initialEtagRef.current = data.etag;
    }
  }, [data?.etag]);
  const baseConfigChanged =
    data?.etag !== undefined &&
    initialEtagRef.current !== undefined &&
    data.etag !== initialEtagRef.current;
  const currentEditValue = editedConfig ?? baseConfig;
  const hasChanges = editedConfig !== null && editedConfig !== baseConfig;

  useEffect(() => {
    setIsMounted(true);
  }, []);

  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      const next = value ?? '';
      if (next === baseConfig) {
        setEditedConfig(null);
      } else {
        setEditedConfig(next);
      }
    },
    [baseConfig]
  );

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-4">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-muted-foreground text-sm">Loading config...</span>
      </div>
    );
  }

  if (error) {
    return (
      <Alert className="my-2">
        <AlertDescription>
          {error instanceof Error ? error.message : 'Failed to load config'}
        </AlertDescription>
      </Alert>
    );
  }

  if (!data) return null;

  if (!isMounted) {
    return <EditorLoading />;
  }

  const handleReload = () => {
    initialEtagRef.current = data.etag;
    setEditedConfig(null);
  };

  return (
    <div className="space-y-3">
      {baseConfigChanged && hasChanges && (
        <Alert variant="warning">
          <AlertDescription className="flex items-center justify-between">
            <span>
              The config was updated externally. Your edits are based on an older version.
            </span>
            <Button variant="outline" size="sm" onClick={handleReload}>
              Reload latest
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <div className="flex flex-col gap-3 md:flex-row">
        <div className="min-w-0 md:flex-1">
          <p className="text-muted-foreground mb-1 text-xs font-medium">Editor</p>
          <div className="overflow-hidden rounded-md border">
            <Suspense fallback={<EditorLoading />}>
              <Editor
                height="500px"
                defaultLanguage="json"
                value={currentEditValue}
                onChange={handleEditorChange}
                theme="vs-dark"
                options={EDITOR_OPTIONS}
                keepCurrentModel
              />
            </Suspense>
          </div>
        </div>

        <div className="min-w-0 md:flex-1">
          <p className="text-muted-foreground mb-1 text-xs font-medium">Diff</p>
          {hasChanges ? (
            <div className="overflow-hidden rounded-md border">
              <Suspense fallback={<EditorLoading />}>
                <DiffEditor
                  height="500px"
                  language="json"
                  original={baseConfig}
                  modified={currentEditValue}
                  theme="vs-dark"
                  keepCurrentOriginalModel
                  keepCurrentModifiedModel
                  options={{
                    ...EDITOR_OPTIONS,
                    readOnly: true,
                    lineNumbers: 'off',
                    renderSideBySide: false,
                    hideUnchangedRegions: {
                      enabled: true,
                      contextLineCount: 2,
                      minimumLineCount: 3,
                      revealLineCount: 10,
                    },
                    diffAlgorithm: 'advanced',
                  }}
                />
              </Suspense>
            </div>
          ) : (
            <div className="bg-muted flex min-h-[500px] items-center justify-center rounded-md border">
              <p className="text-muted-foreground text-sm">No changes</p>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onOpenChange(false)}
          disabled={mutations.replaceOpenclawConfig.isPending}
        >
          Discard
        </Button>
        <Button
          variant="default"
          size="sm"
          disabled={!hasChanges || mutations.replaceOpenclawConfig.isPending}
          onClick={() => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(currentEditValue);
            } catch {
              toast.error('Invalid JSON — fix syntax errors before submitting');
              return;
            }
            if (!isJsonObject(parsed)) {
              toast.error('Config must be a JSON object');
              return;
            }
            mutations.replaceOpenclawConfig.mutate(
              { config: parsed, etag: data.etag },
              {
                onSuccess: () => {
                  toast.success('Config replaced');
                  onOpenChange(false);
                },
                onError: err => {
                  if (
                    err.data?.code === 'CONFLICT' &&
                    err.data?.upstreamCode === 'config_etag_conflict'
                  ) {
                    void refetch();
                    toast.error(
                      'Config was modified externally — click "Reload latest" to sync, then re-apply your changes'
                    );
                  } else {
                    toast.error(err.message);
                  }
                },
              }
            );
          }}
        >
          {mutations.replaceOpenclawConfig.isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Submitting...
            </>
          ) : (
            'Submit'
          )}
        </Button>
      </div>
    </div>
  );
}
