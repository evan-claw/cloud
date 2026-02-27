import { Loader2, Check, X } from 'lucide-react';
import type { AutocommitStatus as AutocommitStatusType } from './store/atoms';

export function AutocommitStatus({ status }: { status: AutocommitStatusType }) {
  return (
    <div className="flex items-center gap-3 py-4">
      <div className="bg-border h-px flex-1" />
      <div className="flex items-center gap-2 text-xs">
        <StatusIndicator status={status} />
      </div>
      <div className="bg-border h-px flex-1" />
    </div>
  );
}

function StatusIndicator({ status }: { status: AutocommitStatusType }) {
  switch (status.status) {
    case 'in_progress':
      return (
        <span className="text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>{status.message}</span>
        </span>
      );
    case 'completed':
      return (
        <span className="text-muted-foreground flex items-center gap-2">
          <Check className="h-3 w-3" />
          <span>{status.message}</span>
        </span>
      );
    case 'failed':
      return (
        <span className="text-destructive flex items-center gap-2">
          <X className="h-3 w-3" />
          <span>{status.message}</span>
        </span>
      );
  }
}
