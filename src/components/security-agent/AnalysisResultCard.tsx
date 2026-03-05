'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Brain, Zap, AlertTriangle, CheckCircle, XCircle, HelpCircle } from 'lucide-react';
import type {
  SecurityFindingAnalysis,
  SecurityFindingTriage,
} from '@/lib/security-agent/core/types';
import { MarkdownProse } from './MarkdownProse';

type AnalysisResultCardProps = {
  analysis: SecurityFindingAnalysis;
  /** Show the reasoning for why sandbox analysis is running (when tier 2 is in progress) */
  showSandboxReasoning?: boolean;
};

function getOptionalStringField(source: unknown, key: string): string | undefined {
  if (typeof source !== 'object' || source === null) {
    return undefined;
  }

  const value = Reflect.get(source, key);
  return typeof value === 'string' ? value : undefined;
}

/**
 * Get the markdown content to display from an analysis result.
 * Prefers sandboxAnalysis.rawMarkdown if available, falls back to rawMarkdown.
 */
function getAnalysisMarkdown(analysis: SecurityFindingAnalysis): string | null {
  // Prefer sandbox analysis markdown if available
  if (analysis.sandboxAnalysis?.rawMarkdown) {
    return analysis.sandboxAnalysis.rawMarkdown;
  }
  // Fall back to top-level rawMarkdown (legacy format or fallback)
  return analysis.rawMarkdown ?? null;
}

/**
 * Badge colors for triage suggested actions
 */
function getSuggestedActionBadge(action: SecurityFindingTriage['suggestedAction']) {
  switch (action) {
    case 'dismiss':
      return (
        <Badge variant="outline" className="border-green-500/50 bg-green-500/10 text-green-400">
          <CheckCircle className="mr-1 h-3 w-3" />
          Safe to Dismiss
        </Badge>
      );
    case 'analyze_codebase':
      return (
        <Badge variant="outline" className="border-yellow-500/50 bg-yellow-500/10 text-yellow-400">
          <AlertTriangle className="mr-1 h-3 w-3" />
          Needs Analysis
        </Badge>
      );
    case 'manual_review':
      return (
        <Badge variant="outline" className="border-red-500/50 bg-red-500/10 text-red-400">
          <XCircle className="mr-1 h-3 w-3" />
          Manual Review
        </Badge>
      );
    default:
      return null;
  }
}

/**
 * Badge colors for confidence levels
 */
function getConfidenceBadge(confidence: SecurityFindingTriage['confidence']) {
  switch (confidence) {
    case 'high':
      return (
        <Badge variant="outline" className="border-blue-500/50 bg-blue-500/10 text-blue-400">
          High Confidence
        </Badge>
      );
    case 'medium':
      return (
        <Badge variant="outline" className="border-orange-500/50 bg-orange-500/10 text-orange-400">
          Medium Confidence
        </Badge>
      );
    case 'low':
      return (
        <Badge variant="outline" className="border-gray-500/50 bg-gray-500/10 text-gray-400">
          Low Confidence
        </Badge>
      );
    default:
      return null;
  }
}

/**
 * Badge for exploitability status
 */
function getExploitabilityBadge(isExploitable: boolean | 'unknown') {
  switch (isExploitable) {
    case true:
      return (
        <Badge variant="outline" className="border-red-500/50 bg-red-500/10 text-red-400">
          <XCircle className="mr-1 h-3 w-3" />
          Exploitable
        </Badge>
      );
    case false:
      return (
        <Badge variant="outline" className="border-green-500/50 bg-green-500/10 text-green-400">
          <CheckCircle className="mr-1 h-3 w-3" />
          Not Exploitable
        </Badge>
      );
    case 'unknown':
      return (
        <Badge variant="outline" className="border-gray-500/50 bg-gray-500/10 text-gray-400">
          <HelpCircle className="mr-1 h-3 w-3" />
          Unknown
        </Badge>
      );
    default:
      return null;
  }
}

/**
 * Triage summary section - shows quick triage results
 */
function TriageSummary({
  triage,
  showSandboxReasoning = false,
}: {
  triage: SecurityFindingTriage;
  /** Show the reasoning for why sandbox analysis is needed (when tier 2 is running) */
  showSandboxReasoning?: boolean;
}) {
  return (
    <div className="mb-4 rounded-lg border border-purple-500/20 bg-purple-500/5 p-4">
      <div className="mb-2 flex items-center gap-2">
        <Zap className="h-4 w-4 text-purple-400" />
        <span className="text-sm font-medium text-purple-400">Quick Triage</span>
      </div>
      <div className="mb-3 flex flex-wrap gap-2">
        {getSuggestedActionBadge(triage.suggestedAction)}
        {getConfidenceBadge(triage.confidence)}
      </div>
      <MarkdownProse
        markdown={triage.needsSandboxReasoning}
        className="text-muted-foreground text-sm"
      />
      {showSandboxReasoning && triage.needsSandboxAnalysis && (
        <div className="mt-3 rounded border border-blue-500/20 bg-blue-500/5 p-2">
          <p className="text-xs text-blue-400">
            <Brain className="mr-1 inline h-3 w-3" />
            Running deep codebase analysis to verify exploitability...
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Sandbox analysis summary - shows detailed analysis results
 */
function SandboxSummary({
  sandboxAnalysis,
}: {
  sandboxAnalysis: NonNullable<SecurityFindingAnalysis['sandboxAnalysis']>;
}) {
  return (
    <div className="mb-4 rounded-lg border border-blue-500/20 bg-blue-500/5 p-4">
      <div className="mb-2 flex items-center gap-2">
        <Brain className="h-4 w-4 text-blue-400" />
        <span className="text-sm font-medium text-blue-400">Codebase Analysis</span>
      </div>
      <div className="mb-3 flex flex-wrap gap-2">
        {getExploitabilityBadge(sandboxAnalysis.isExploitable)}
      </div>
      {sandboxAnalysis.summary && (
        <p className="text-muted-foreground mb-2 text-sm">{sandboxAnalysis.summary}</p>
      )}
      {sandboxAnalysis.usageLocations && sandboxAnalysis.usageLocations.length > 0 && (
        <div className="mt-2">
          <span className="text-muted-foreground text-xs font-medium">Usage locations:</span>
          <ul className="text-muted-foreground mt-1 list-inside list-disc text-xs">
            {(() => {
              const occurrenceByLocation = new Map<string, number>();

              return sandboxAnalysis.usageLocations.slice(0, 5).map(loc => {
                const occurrence = occurrenceByLocation.get(loc) ?? 0;
                occurrenceByLocation.set(loc, occurrence + 1);

                return (
                  <li key={`${loc}-${occurrence}`} className="truncate">
                    {loc}
                  </li>
                );
              });
            })()}
            {sandboxAnalysis.usageLocations.length > 5 && (
              <li className="text-muted-foreground/70">
                ...and {sandboxAnalysis.usageLocations.length - 5} more
              </li>
            )}
          </ul>
        </div>
      )}
      {sandboxAnalysis.suggestedFix && (
        <div className="mt-2">
          <span className="text-muted-foreground text-xs font-medium">Suggested fix:</span>
          <p className="text-muted-foreground mt-1 text-xs">{sandboxAnalysis.suggestedFix}</p>
        </div>
      )}
    </div>
  );
}

export function AnalysisResultCard({
  analysis,
  showSandboxReasoning = false,
}: AnalysisResultCardProps) {
  const markdown = getAnalysisMarkdown(analysis);
  const hasTriage = !!analysis.triage;
  const hasSandbox = !!analysis.sandboxAnalysis;
  const triageModelUsed =
    getOptionalStringField(analysis.triage, 'modelUsed') ??
    getOptionalStringField(analysis, 'triageModelUsed') ??
    getOptionalStringField(analysis, 'triageModel');
  const analysisModelUsed =
    analysis.sandboxAnalysis?.modelUsed ??
    getOptionalStringField(analysis, 'analysisModelUsed') ??
    getOptionalStringField(analysis, 'analysisModel');
  const modelSummary =
    triageModelUsed || analysisModelUsed
      ? [
          triageModelUsed ? `Triage: ${triageModelUsed}` : null,
          analysisModelUsed ? `Analysis: ${analysisModelUsed}` : null,
        ]
          .filter(Boolean)
          .join(' • ')
      : analysis.modelUsed;

  return (
    <Card className="w-full min-w-0 overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-center space-x-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-500/20">
            <Brain className="h-5 w-5 text-purple-400" />
          </div>
          <div>
            <CardTitle className="text-lg font-bold">AI Analysis</CardTitle>
            <p className="text-muted-foreground text-xs">
              Analyzed {new Date(analysis.analyzedAt).toLocaleDateString()}
              {modelSummary && ` • ${modelSummary}`}
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="min-w-0 overflow-hidden">
        {/* Show triage summary if available */}
        {hasTriage && analysis.triage && (
          <TriageSummary triage={analysis.triage} showSandboxReasoning={showSandboxReasoning} />
        )}

        {/* Show sandbox analysis summary if available */}
        {hasSandbox && analysis.sandboxAnalysis && (
          <SandboxSummary sandboxAnalysis={analysis.sandboxAnalysis} />
        )}

        {/* Show full markdown analysis if available */}
        {markdown && <MarkdownProse markdown={markdown} className="text-muted-foreground" />}

        {/* Fallback if no content */}
        {!hasTriage && !hasSandbox && !markdown && (
          <p className="text-muted-foreground text-sm">No analysis content available.</p>
        )}
      </CardContent>
    </Card>
  );
}
