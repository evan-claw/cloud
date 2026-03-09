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
  gateResult?: 'pass' | 'fail';
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
  gateResult?: 'pass' | 'fail';
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
  gateResult?: 'pass' | 'fail';
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
    gateResult: raw.gateResult,
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
 * Returns null for statuses that don't have a check run mapping (e.g. 'queued').
 *
 * When `gateResult` is `'fail'` and the review completed successfully (no system error),
 * the conclusion is set to `'failure'` — the agent determined that the review found
 * blocking issues (based on the `gate_threshold` setting in the agent config).
 */
function mapStatusToCheckRun(
  reviewStatus: string,
  errorMessage?: string,
  gateResult?: 'pass' | 'fail'
) {
  const statusMap: Record<string, 'in_progress' | 'completed'> = {
    running: 'in_progress',
    completed: 'completed',
    failed: 'completed',
    cancelled: 'completed',
  };

  const checkStatus = statusMap[reviewStatus];
  if (!checkStatus) return null;

  // When the review completed but the agent reported a gate failure
  // (e.g. findings exceeding the gate_threshold), fail the check.
  const reviewFailed = reviewStatus === 'completed' && gateResult === 'fail';

  const conclusionMap: Record<string, CheckRunConclusion> = {
    completed: reviewFailed ? 'failure' : 'success',
    failed: 'failure',
    cancelled: 'cancelled',
  };

  const titleMap: Record<string, string> = {
    running: 'Kilo Code Review in progress',
    completed: reviewFailed ? 'Kilo Code Review found issues' : 'Kilo Code Review completed',
    failed: 'Kilo Code Review failed',
    cancelled: 'Kilo Code Review cancelled',
  };

  const summaryMap: Record<string, string> = {
    running: 'Review is running...',
    completed: reviewFailed
      ? 'Code review completed with findings that require attention.'
      : 'Code review completed successfully.',
    failed: errorMessage ? `Review failed: ${errorMessage}` : 'Review failed.',
    cancelled: 'Review was cancelled.',
  };

  return {
    status: checkStatus,
    conclusion: conclusionMap[reviewStatus],
    title: titleMap[reviewStatus] ?? 'Kilo Code Review',
    summary: summaryMap[reviewStatus] ?? '',
  };
}

/**
 * Maps a review status to a GitLab commit status state.
 */
function mapStatusToGitLabState(
  reviewStatus: string,
  gateResult?: 'pass' | 'fail'
): GitLabCommitStatusState {
  if (reviewStatus === 'completed' && gateResult === 'fail') return 'failed';
  const stateMap: Record<string, GitLabCommitStatusState> = {
    running: 'running',
    completed: 'success',
    failed: 'failed',
    cancelled: 'canceled',
  };
  return stateMap[reviewStatus] ?? 'pending';
}

/**
 * Resolves a GitLab access token for a review's project.
 * Prefers a stored Project Access Token; falls back to the user's OAuth token.
 */
async function resolveGitLabAccessToken(
  integration: PlatformIntegration,
  projectId: number | null
): Promise<string> {
  const storedPrat = projectId ? getStoredProjectAccessToken(integration, projectId) : null;
  return storedPrat ? storedPrat.token : await getValidGitLabToken(integration);
}

/**
 * Extracts the GitLab instance URL from an integration's metadata.
 */
function getGitLabInstanceUrl(integration: PlatformIntegration): string {
  const metadata = integration.metadata as { gitlab_instance_url?: string } | null;
  return metadata?.gitlab_instance_url || 'https://gitlab.com';
}

/**
 * Update the GitHub Check Run or GitLab commit status for a review.
 * Non-blocking — errors are logged but don't fail the callback.
 */
async function updatePRGateCheck(
  review: CloudAgentCodeReview,
  integration: PlatformIntegration,
  reviewStatus: string,
  errorMessage?: string,
  gitlabAccessToken?: string,
  gateResult?: 'pass' | 'fail'
) {
  const platform = review.platform || 'github';
  const detailsUrl = `${APP_URL}/code-reviews/${review.id}`;

  const checkRunMapping = mapStatusToCheckRun(reviewStatus, errorMessage, gateResult);
  if (!checkRunMapping) return; // unsupported status (e.g. 'queued') — nothing to update

  if (platform === 'github' && integration.platform_installation_id) {
    // GitHub: update Check Run (only if we have a check_run_id)
    if (!review.check_run_id) return;

    const [repoOwner, repoName] = review.repo_full_name.split('/');

    await updateCheckRun(
      integration.platform_installation_id,
      repoOwner,
      repoName,
      review.check_run_id,
      {
        status: checkRunMapping.status,
        conclusion: checkRunMapping.conclusion,
        detailsUrl,
        output: { title: checkRunMapping.title, summary: checkRunMapping.summary },
      }
    );

    logExceptInTest(
      `[code-review-status] Updated check run for ${review.repo_full_name}#${review.pr_number}`,
      { status: checkRunMapping.status, conclusion: checkRunMapping.conclusion }
    );
  } else if (platform === PLATFORM.GITLAB) {
    // GitLab: update commit status
    const instanceUrl = getGitLabInstanceUrl(integration);
    const projectId = review.platform_project_id;
    const accessToken =
      gitlabAccessToken ?? (await resolveGitLabAccessToken(integration, projectId));

    const state = mapStatusToGitLabState(reviewStatus, gateResult);

    await setCommitStatus(
      accessToken,
      projectId ?? review.repo_full_name,
      review.head_sha,
      state,
      {
        targetUrl: detailsUrl,
        description: checkRunMapping.title,
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
    const { status, sessionId, cliSessionId, errorMessage, gateResult } =
      normalizePayload(rawPayload);

    // Validate payload
    if (!status) {
      return NextResponse.json({ error: 'Missing required field: status' }, { status: 400 });
    }

    // Warn on unexpected gateResult values so agent-side typos surface early
    const validGateResult = gateResult === 'pass' || gateResult === 'fail' ? gateResult : undefined;
    if (gateResult && !validGateResult) {
      logExceptInTest('[code-review-status] Unexpected gateResult value, ignoring', {
        gateResult,
      });
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

    // Fetch integration once — used for gate check updates and post-completion actions
    const integration = review.platform_integration_id
      ? await getIntegrationById(review.platform_integration_id)
      : null;

    // Resolve GitLab token once, shared between gate check and reaction/footer logic
    const isGitLab = (review.platform || 'github') === PLATFORM.GITLAB;
    const gitlabAccessToken =
      integration && isGitLab
        ? await resolveGitLabAccessToken(integration, review.platform_project_id).catch(
            () => undefined
          )
        : undefined;

    // Update PR gate check BEFORE writing terminal DB state.
    // Once the DB moves to a terminal status, subsequent callbacks hit the early-return
    // above, so a flaky gate update would be unrecoverable.
    if (integration) {
      try {
        await updatePRGateCheck(
          review,
          integration,
          status,
          errorMessage,
          gitlabAccessToken,
          validGateResult
        );
      } catch (gateCheckError) {
        logExceptInTest('[code-review-status] Failed to update PR gate check:', gateCheckError);
        const isTerminal = status === 'completed' || status === 'failed' || status === 'cancelled';
        if (isTerminal) {
          captureException(gateCheckError, {
            tags: { source: 'code-review-status-gate-check' },
            extra: { reviewId, status, checkRunId: String(review.check_run_id ?? '') },
          });
          // Abort so the caller retries — once the DB moves to a terminal status
          // the early-return above prevents any later attempt to update the gate.
          throw gateCheckError;
        }
      }
    }

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
              const instanceUrl = getGitLabInstanceUrl(integration);
              const accessToken =
                gitlabAccessToken ??
                (await resolveGitLabAccessToken(integration, review.platform_project_id));

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
