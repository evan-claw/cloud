'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Download } from 'lucide-react';
import { useExportUsageCsv } from '@/app/api/organizations/hooks';
import { format, subDays } from 'date-fns';

function triggerCsvDownload(csvData: string, startDate: string, endDate: string) {
  const blob = new Blob([csvData], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.setAttribute('href', url);
  link.setAttribute('download', `usage-chargeback-${startDate}-to-${endDate}.csv`);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

type UsageCsvExportCardProps = {
  organizationId: string;
};

export function UsageCsvExportCard({ organizationId }: UsageCsvExportCardProps) {
  const today = format(new Date(), 'yyyy-MM-dd');
  const thirtyDaysAgo = format(subDays(new Date(), 30), 'yyyy-MM-dd');

  const [startDate, setStartDate] = useState(thirtyDaysAgo);
  const [endDate, setEndDate] = useState(today);

  const exportMutation = useExportUsageCsv();

  const handleExport = () => {
    exportMutation.mutate(
      { organizationId, startDate, endDate },
      {
        onSuccess: result => {
          triggerCsvDownload(result.data, startDate, endDate);
        },
      }
    );
  };

  const dateRangeValid = startDate && endDate && startDate <= endDate;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Download className="h-5 w-5" />
          Export Usage CSV
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground text-sm">
          Download a CSV of model usage costs by date and user for chargeback purposes.
        </p>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="csv-start-date">Start date</Label>
            <Input
              id="csv-start-date"
              type="date"
              value={startDate}
              max={endDate || today}
              onChange={e => setStartDate(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="csv-end-date">End date</Label>
            <Input
              id="csv-end-date"
              type="date"
              value={endDate}
              min={startDate}
              max={today}
              onChange={e => setEndDate(e.target.value)}
            />
          </div>
          <Button onClick={handleExport} disabled={!dateRangeValid || exportMutation.isPending}>
            <Download className="mr-2 h-4 w-4" />
            {exportMutation.isPending ? 'Exporting...' : 'Download CSV'}
          </Button>
        </div>
        {exportMutation.isError && (
          <p className="text-destructive text-sm">Failed to export CSV. Please try again.</p>
        )}
      </CardContent>
    </Card>
  );
}
