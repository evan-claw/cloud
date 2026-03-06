/**
 * Internal API Endpoint: Code Review Status Updates
 *
 * Called by:
 * - Code Review Orchestrator (for 'running' status and sessionId updates)
 * - Cloud-agent-next callback (for 'completed', 'failed', or 'interrupted' status)
 *
 * Accepts both legacy format (from orchestrator) and cloud-agent-next callback format:
 * - Legacy: { status, sessionId?, cliSessionId?, errorMessage? }
 * - cloud-agent-next: { status, sessionId?, cloudAgentSessionId?, executionId?,
 *     kiloSessionId?, errorMessage?, lastSeenBranch? }
 *
 * The reviewId is passed in the URL path.
 *
 * URL: POST /api/internal/code-review-status/{reviewId}
 * Protected by internal API secret
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { updateCodeReviewStatus, getCodeReviewById } from '@/lib/code-reviews/db/code-reviews';
import { tryDispatchPendingReviews } from '@/lib/code-reviews/dispatch/dispatch-pending-reviews';
import { getBotUserId } from '@/lib/bot-users/bot-user-service';
import { logExceptInTest, errorExceptInTest } from '@/lib/utils.server';
import {
  addReactionToPR,
  findKiloReviewComment,
  updateKiloReviewComment,
  updateCheckRun,
} from '@/lib/integrations/platforms/github/adapter';
import type { CheckRunConclusion } from '@/lib/integrations/platforms/github/adapter';
import {
  addReactionToMR,
  findKiloReviewNote,
  updateKiloReviewNote,
  setCommitStatus,
} from '@/lib/integrations/platforms/gitlab/adapter';
import type { GitLabCommitStatusState } from '@/lib/integrations/platforms/gitlab/adapter';
import { getIntegrationById } from '@/lib/integrations/db/platform-integrations';
import {
  getValidGitLabToken,
  getStoredProjectAccessToken,
} from '@/lib/integrations/gitlab-service';
import { captureException, captureMessage } from '@sentry/nextjs';
import { INTERNAL_API_SECRET } from '@/lib/config.server';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { appendUsageFooter } from '@/lib/code-reviews/summary/usage-footer';
import { APP_URL } from '@/lib/constants';
import type { CloudAgentCodeReview, PlatformIntegration } from '@kilocode/db/schema';

/**
 * Payload from the orchestrator DO (legacy format).
 */
type OrchestratorPayload = {
  sessionId?: string;
  cliSessionId?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  errorMessage?: string;
};

/**
 * Payload from cloud-agent-next callback (ExecutionCallbackPayload).
 */
type CloudAgentNextCallbackPayload = {
  sessionId?: string;
  cloudAgentSessionId?: string;
  executionId?: string;
  kiloSessionId?: string;
  status: 'completed' | 'failed' | 'interrupted';
  errorMessage?: string;
  lastSeenBranch?: string;
};

type StatusUpdatePayload = OrchestratorPayload | CloudAgentNextCallbackPayload;

/**
 * Normalize a payload from either the orchestrator or cloud-agent-next callback
 * into the common format expected by the update logic.
 */
function normalizePayload(raw: StatusUpdatePayload): {
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  sessionId?: string;
  cliSessionId?: string;
  errorMessage?: string;
} {
  // Map cloud-agent-next 'interrupted' → 'cancelled'
  const status = raw.status === 'interrupted' ? 'cancelled' : raw.status;

  // Map cloud-agent-next 'kiloSessionId' → 'cliSessionId'
  const cliSessionId =
    'cliSessionId' in raw
      ? raw.cliSessionId
      : 'kiloSessionId' in raw
        ? raw.kiloSessionId
        : undefined;

  // Map cloud-agent-next 'cloudAgentSessionId' → 'sessionId' as fallback
  const sessionId =
    raw.sessionId ?? ('cloudAgentSessionId' in raw ? raw.cloudAgentSessionId : undefined);

  return {
    status,
    sessionId,
    cliSessionId,
    errorMessage: raw.errorMessage,
  };
}

/**
 * Read a review's usage data, polling with exponential backoff if not yet available.
 * Handles the race between the orchestrator's usage report and the cloud agent's completion callback.
 */
async function getReviewUsageData(reviewId: string) {
  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 200;

  let review = await getCodeReviewById(reviewId);

  for (let attempt = 0; attempt < MAX_RETRIES && review && !review.model; attempt++) {
    await new Promise(resolve => setTimeout(resolve, BASE_DELAY_MS * 2 ** attempt));
    review = await getCodeReviewById(reviewId);
  }

  return {
    model: review?.model ?? null,
    tokensIn: review?.total_tokens_in ?? null,
    tokensOut: review?.total_tokens_out ?? null,
  };
}

/**
 * Maps a review status to a GitHub Check Run update.
 */
function mapStatusToCheckRun(reviewStatus: string, errorMessage?: string) {
  const conclusionMap: Record<string, CheckRunConclusion> = {
    completed: 'success',
    failed: 'failure',
    cancelled: 'cancelled',
  };

  const titleMap: Record<string, string> = {
    running: 'Kilo Code Review in progress',
    completed: 'Kilo Code Review completed',
    failed: 'Kilo Code Review failed',
    cancelled: 'Kilo Code Review cancelled',
  };

  const summaryMap: Record<string, string> = {
    running: 'Review is running...',
    completed: 'Code review completed successfully.',
    failed: errorMessage ? `Review failed: ${errorMessage}` : 'Review failed.',
    cancelled: 'Review was cancelled.',
  };

  return {
    status: (reviewStatus === 'running' ? 'in_progress' : 'completed') as
      | 'in_progress'
      | 'completed',
    conclusion: conclusionMap[reviewStatus],
    title: titleMap[reviewStatus] ?? 'Kilo Code Review',
    summary: summaryMap[reviewStatus] ?? '',
  };
}

/**
 * Maps a review status to a GitLab commit status state.
 */
function mapStatusToGitLabState(reviewStatus: string): GitLabCommitStatusState {
  const stateMap: Record<string, GitLabCommitStatusState> = {
    running: 'running',
    completed: 'success',
    failed: 'failed',
    cancelled: 'canceled',
  };
  return stateMap[reviewStatus] ?? 'pending';
}

/**
 * Update the GitHub Check Run or GitLab commit status for a review.
 * Non-blocking — errors are logged but don't fail the callback.
 */
async function updatePRGateCheck(
  review: CloudAgentCodeReview,
  integration: PlatformIntegration,
  reviewStatus: string,
  errorMessage?: string
) {
  const platform = review.platform || 'github';
  const detailsUrl = `${APP_URL}/code-reviews/${review.id}`;

  if (platform === 'github' && integration.platform_installation_id) {
    // GitHub: update Check Run (only if we have a check_run_id)
    if (!review.check_run_id) return;

    const [repoOwner, repoName] = review.repo_full_name.split('/');
    const { status, conclusion, title, summary } = mapStatusToCheckRun(reviewStatus, errorMessage);

    await updateCheckRun(
      integration.platform_installation_id,
      repoOwner,
      repoName,
      review.check_run_id,
      {
        status,
        conclusion,
        detailsUrl,
        output: { title, summary },
      }
    );

    logExceptInTest(
      `[code-review-status] Updated check run for ${review.repo_full_name}#${review.pr_number}`,
      { status, conclusion }
    );
  } else if (platform === PLATFORM.GITLAB) {
    // GitLab: update commit status
    const metadata = integration.metadata as { gitlab_instance_url?: string } | null;
    const instanceUrl = metadata?.gitlab_instance_url || 'https://gitlab.com';
    const projectId = review.platform_project_id;
    const storedPrat = projectId ? getStoredProjectAccessToken(integration, projectId) : null;
    const accessToken = storedPrat ? storedPrat.token : await getValidGitLabToken(integration);

    const state = mapStatusToGitLabState(reviewStatus);
    const { title } = mapStatusToCheckRun(reviewStatus, errorMessage);

    await setCommitStatus(
      accessToken,
      projectId ?? review.repo_full_name,
      review.head_sha,
      state,
      {
        targetUrl: detailsUrl,
        description: title,
      },
      instanceUrl
    );

    logExceptInTest(
      `[code-review-status] Updated commit status for GitLab MR ${review.repo_full_name}!${review.pr_number}`,
      { state }
    );
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ reviewId: string }> }
) {
  try {
    // Validate internal API secret
    const secret = req.headers.get('X-Internal-Secret');
    if (!INTERNAL_API_SECRET || secret !== INTERNAL_API_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { reviewId } = await params;
    const rawPayload: StatusUpdatePayload = await req.json();
    const { status, sessionId, cliSessionId, errorMessage } = normalizePayload(rawPayload);

    // Validate payload
    if (!status) {
      return NextResponse.json({ error: 'Missing required field: status' }, { status: 400 });
    }

    logExceptInTest('[code-review-status] Received status update', {
      reviewId,
      sessionId,
      cliSessionId,
      status,
      hasError: !!errorMessage,
      ...(errorMessage ? { errorMessage } : {}),
    });

    // Get current review to check if update is needed
    const review = await getCodeReviewById(reviewId);

    if (!review) {
      logExceptInTest('[code-review-status] Review not found', { reviewId });
      return NextResponse.json({ error: 'Review not found' }, { status: 404 });
    }

    // Determine valid transitions based on incoming status
    const isTerminalState =
      review.status === 'completed' || review.status === 'failed' || review.status === 'cancelled';

    if (isTerminalState) {
      // Already in terminal state - skip update
      logExceptInTest('[code-review-status] Review already in terminal state, skipping update', {
        reviewId,
        currentStatus: review.status,
        requestedStatus: status,
      });
      return NextResponse.json({
        success: true,
        message: 'Review already in terminal state',
        currentStatus: review.status,
      });
    }

    // Valid transitions:
    // - queued -> running (orchestrator starting)
    // - running -> running (sessionId update)
    // - running -> completed/failed (callback)
    // - queued -> completed/failed (edge case: immediate failure)

    // Update review status in database
    await updateCodeReviewStatus(reviewId, status, {
      sessionId,
      cliSessionId,
      errorMessage,
      startedAt: status === 'running' ? new Date() : undefined,
      completedAt:
        status === 'completed' || status === 'failed' || status === 'cancelled'
          ? new Date()
          : undefined,
    });

    logExceptInTest('[code-review-status] Updated review status', {
      reviewId,
      sessionId,
      cliSessionId,
      status,
    });

    // Fetch integration once — used for gate check updates and post-completion actions
    const integration = review.platform_integration_id
      ? await getIntegrationById(review.platform_integration_id)
      : null;

    // Update PR gate check (GitHub Check Run / GitLab commit status)
    if (integration) {
      try {
        await updatePRGateCheck(review, integration, status, errorMessage);
      } catch (gateCheckError) {
        // Non-blocking — log but don't fail the status callback
        logExceptInTest('[code-review-status] Failed to update PR gate check:', gateCheckError);
      }
    }

    // Only trigger dispatch for terminal states (completed/failed/cancelled)
    // This frees up a slot for the next pending review
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      let owner;
      if (review.owned_by_organization_id) {
        const botUserId = await getBotUserId(review.owned_by_organization_id, 'code-review');
        if (botUserId) {
          owner = {
            type: 'org' as const,
            id: review.owned_by_organization_id,
            userId: botUserId,
          };
        } else {
          errorExceptInTest('[code-review-status] Bot user not found for organization', {
            organizationId: review.owned_by_organization_id,
            reviewId,
          });
          captureMessage('Bot user missing for organization code review', {
            level: 'error',
            tags: { source: 'code-review-status' },
            extra: { organizationId: review.owned_by_organization_id, reviewId },
          });
        }
      } else {
        owner = {
          type: 'user' as const,
          id: review.owned_by_user_id || '',
          userId: review.owned_by_user_id || '',
        };
      }

      if (owner) {
        // Trigger dispatch in background (don't await - fire and forget)
        tryDispatchPendingReviews(owner).catch(dispatchError => {
          errorExceptInTest(
            '[code-review-status] Error dispatching pending reviews:',
            dispatchError
          );
          captureException(dispatchError, {
            tags: { source: 'code-review-status-dispatch' },
            extra: { reviewId, owner },
          });
        });

        logExceptInTest('[code-review-status] Triggered dispatch for pending reviews', {
          reviewId,
          owner,
        });
      }

      // Add reaction to indicate review completion status AND update usage footer
      if (status === 'completed' || status === 'failed') {
        if (integration) {
          try {
            const platform = review.platform || 'github';

            if (platform === 'github' && integration.platform_installation_id) {
              const [repoOwner, repoName] = review.repo_full_name.split('/');

              // Reaction
              const reaction = status === 'completed' ? 'hooray' : 'confused';
              await addReactionToPR(
                integration.platform_installation_id,
                repoOwner,
                repoName,
                review.pr_number,
                reaction
              );
              logExceptInTest(
                `[code-review-status] Added ${reaction} reaction to ${review.repo_full_name}#${review.pr_number}`
              );

              // Usage footer (completed only)
              if (status === 'completed') {
                const { model, tokensIn, tokensOut } = await getReviewUsageData(reviewId);

                if (model && tokensIn != null && tokensOut != null) {
                  const existing = await findKiloReviewComment(
                    integration.platform_installation_id,
                    repoOwner,
                    repoName,
                    review.pr_number
                  );
                  if (existing) {
                    const updatedBody = appendUsageFooter(
                      existing.body,
                      model,
                      tokensIn,
                      tokensOut
                    );
                    await updateKiloReviewComment(
                      integration.platform_installation_id,
                      repoOwner,
                      repoName,
                      existing.commentId,
                      updatedBody
                    );
                    logExceptInTest(
                      `[code-review-status] Updated summary comment with usage footer on ${review.repo_full_name}#${review.pr_number}`
                    );
                  }
                } else {
                  logExceptInTest(
                    '[code-review-status] Usage data not available for footer update',
                    {
                      reviewId,
                      model,
                      tokensIn,
                      tokensOut,
                    }
                  );
                }
              }
            } else if (platform === PLATFORM.GITLAB) {
              const metadata = integration.metadata as { gitlab_instance_url?: string } | null;
              const instanceUrl = metadata?.gitlab_instance_url || 'https://gitlab.com';
              const projectId = review.platform_project_id;
              const storedPrat = projectId
                ? getStoredProjectAccessToken(integration, projectId)
                : null;
              const accessToken = storedPrat
                ? storedPrat.token
                : await getValidGitLabToken(integration);

              // Reaction
              const emoji = status === 'completed' ? 'tada' : 'confused';
              await addReactionToMR(
                accessToken,
                review.repo_full_name,
                review.pr_number,
                emoji,
                instanceUrl
              );
              logExceptInTest(
                `[code-review-status] Added ${emoji} reaction to GitLab MR ${review.repo_full_name}!${review.pr_number}`
              );

              // Usage footer (completed only)
              if (status === 'completed') {
                const { model, tokensIn, tokensOut } = await getReviewUsageData(reviewId);

                if (model && tokensIn != null && tokensOut != null) {
                  const existing = await findKiloReviewNote(
                    accessToken,
                    review.repo_full_name,
                    review.pr_number,
                    instanceUrl
                  );
                  if (existing) {
                    const updatedBody = appendUsageFooter(
                      existing.body,
                      model,
                      tokensIn,
                      tokensOut
                    );
                    await updateKiloReviewNote(
                      accessToken,
                      review.repo_full_name,
                      review.pr_number,
                      existing.noteId,
                      updatedBody,
                      instanceUrl
                    );
                    logExceptInTest(
                      `[code-review-status] Updated summary note with usage footer on GitLab MR ${review.repo_full_name}!${review.pr_number}`
                    );
                  }
                } else {
                  logExceptInTest(
                    '[code-review-status] Usage data not available for footer update',
                    {
                      reviewId,
                      model,
                      tokensIn,
                      tokensOut,
                    }
                  );
                }
              }
            }
          } catch (postCompletionError) {
            // Non-blocking - log but don't fail the callback
            logExceptInTest(
              '[code-review-status] Failed to add completion reaction or usage footer:',
              postCompletionError
            );
          }
        }
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    errorExceptInTest('[code-review-status] Error processing status update:', error);
    captureException(error, {
      tags: { source: 'code-review-status-api' },
    });

    return NextResponse.json(
      {
        error: 'Failed to process status update',
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
