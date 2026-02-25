'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Download } from 'lucide-react';

function defaultStartDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().split('T')[0];
}

function defaultEndDate(): string {
  return new Date().toISOString().split('T')[0];
}

function triggerCsvDownload(csvData: string, startDate: string, endDate: string) {
  const blob = new Blob([csvData], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.setAttribute('href', url);
  link.setAttribute('download', `chargeback-${startDate}-to-${endDate}.csv`);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

type ChargebackExportProps = {
  organizationId: string;
};

export function ChargebackExport({ organizationId }: ChargebackExportProps) {
  const [startDate, setStartDate] = useState(defaultStartDate);
  const [endDate, setEndDate] = useState(defaultEndDate);

  const trpc = useTRPC();
  const exportMutation = useMutation(
    trpc.organizations.chargebackExport.export.mutationOptions({
      onSuccess: result => {
        triggerCsvDownload(result.data, startDate, endDate);
      },
    })
  );

  const canExport = startDate.length > 0 && endDate.length > 0 && startDate <= endDate;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Chargeback Export</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="chargeback-start-date">Start Date</Label>
            <Input
              id="chargeback-start-date"
              type="date"
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
              className="w-40"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="chargeback-end-date">End Date</Label>
            <Input
              id="chargeback-end-date"
              type="date"
              value={endDate}
              onChange={e => setEndDate(e.target.value)}
              className="w-40"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={!canExport || exportMutation.isPending}
            onClick={() => exportMutation.mutate({ organizationId, startDate, endDate })}
            className="flex items-center gap-2"
          >
            <Download className="h-4 w-4" />
            {exportMutation.isPending ? 'Exporting...' : 'Export Chargeback CSV'}
          </Button>
        </div>
        {exportMutation.isError && (
          <p className="text-destructive mt-2 text-sm">Export failed. Please try again.</p>
        )}
        {exportMutation.isSuccess && (
          <p className="text-muted-foreground mt-2 text-sm">
            Exported {exportMutation.data.rowCount} rows.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
