'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDate } from '@/lib/admin-utils';

type CategoryData = {
  category: string;
  count: number;
  firstOccurrence: string;
  lastOccurrence: string;
};

type DetailData = {
  errorType: string;
  category: string;
  count: number;
  firstOccurrence: string;
  lastOccurrence: string;
};

type ErrorAnalysisData = {
  categories: CategoryData[];
  details: DetailData[];
};

const CATEGORY_COLORS: Record<string, string> = {
  'Rate Limited': 'bg-amber-500',
  Timeout: 'bg-orange-500',
  'Context Window Exceeded': 'bg-purple-500',
  'Auth / Permission Error': 'bg-red-500',
  'Not Found': 'bg-slate-500',
  'Upstream Server Error': 'bg-rose-600',
  'Network Error': 'bg-sky-500',
  'Parse Error': 'bg-indigo-500',
  'Unknown Error': 'bg-gray-400',
  Other: 'bg-gray-500',
};

export function CodeReviewErrorAnalysis({ data }: { data: ErrorAnalysisData }) {
  const totalCategoryErrors = data.categories.reduce((sum, cat) => sum + cat.count, 0);
  // Use category totals (uncapped) as the denominator so percentages are accurate
  // even when the detail list is truncated to top 50.
  const totalErrors = totalCategoryErrors;
  const maxCategoryCount = Math.max(...data.categories.map(c => c.count), 1);

  if (data.details.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Error Analysis</CardTitle>
          <CardDescription>No errors in selected period</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            No failed reviews found in this time range.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Error Analysis</CardTitle>
        <CardDescription>
          {data.categories.length} error categories, {totalCategoryErrors.toLocaleString()} total
          failures
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Category horizontal bar chart */}
        <div className="space-y-2">
          {data.categories.map(cat => {
            const pct = totalCategoryErrors > 0 ? (cat.count / totalCategoryErrors) * 100 : 0;
            const barWidth = (cat.count / maxCategoryCount) * 100;
            const colorClass = CATEGORY_COLORS[cat.category] ?? 'bg-gray-500';
            return (
              <div key={cat.category} className="flex items-center gap-3">
                <span className="w-44 shrink-0 truncate text-right text-xs font-medium">
                  {cat.category}
                </span>
                <div className="bg-muted relative h-5 flex-1 overflow-hidden rounded">
                  <div
                    className={`${colorClass} absolute inset-y-0 left-0 rounded transition-all`}
                    style={{ width: `${barWidth}%` }}
                  />
                </div>
                <span className="text-muted-foreground w-20 shrink-0 text-right text-xs">
                  {cat.count.toLocaleString()} ({pct.toFixed(1)}%)
                </span>
              </div>
            );
          })}
        </div>

        {/* Detail table */}
        <div className="max-h-[400px] overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Category</TableHead>
                <TableHead className="w-[40%]">Error Message</TableHead>
                <TableHead className="text-right">Count</TableHead>
                <TableHead className="text-right">% of Errors</TableHead>
                <TableHead>First Seen</TableHead>
                <TableHead>Last Seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.details.map((error, idx) => (
                <TableRow key={idx}>
                  <TableCell className="text-xs">{error.category}</TableCell>
                  <TableCell
                    className="max-w-[400px] truncate font-mono text-xs"
                    title={error.errorType}
                  >
                    {error.errorType}
                  </TableCell>
                  <TableCell className="text-right font-medium">{error.count}</TableCell>
                  <TableCell className="text-muted-foreground text-right">
                    {((error.count / totalErrors) * 100).toFixed(1)}%
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {formatDate(error.firstOccurrence)}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {formatDate(error.lastOccurrence)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
