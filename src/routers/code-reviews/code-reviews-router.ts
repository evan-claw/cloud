/**
 * Code Reviews tRPC Router
 *
 * API endpoints for managing cloud agent code reviews.
 * Supports both organization and personal user code reviews.
 */

import { createTRPCRouter, baseProcedure } from '@/lib/trpc/init';
import {
  organizationMemberProcedure,
  ensureOrganizationAccess,
} from '@/routers/organizations/utils';
import { TRPCError } from '@trpc/server';
import { successResult, failureResult } from '@/lib/maybe-result';
import * as z from 'zod';
import {
  listCodeReviews,
  countCodeReviews,
  getCodeReviewById,
  cancelCodeReview,
  resetCodeReviewForRetry,
  updateCheckRunId,
} from '@/lib/code-reviews/db/code-reviews';
import { getIntegrationById } from '@/lib/integrations/db/platform-integrations';
import { createCheckRun, updateCheckRun } from '@/lib/integrations/platforms/github/adapter';
import { setCommitStatus } from '@/lib/integrations/platforms/gitlab/adapter';
import {
  getValidGitLabToken,
  getStoredProjectAccessToken,
} from '@/lib/integrations/gitlab-service';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { APP_URL } from '@/lib/constants';
import { logExceptInTest } from '@/lib/utils.server';
import {
  ListCodeReviewsInputSchema,
  ListCodeReviewsForUserInputSchema,
  GetCodeReviewInputSchema,
  CancelCodeReviewInputSchema,
  RetriggerCodeReviewInputSchema,
  type Owner,
  type ListCodeReviewsResponse,
} from '@/lib/code-reviews/core';
import { DEFAULT_LIST_LIMIT } from '@/lib/code-reviews/core/constants';
import { codeReviewWorkerClient } from '@/lib/code-reviews/client/code-review-worker-client';
import { tryDispatchPendingReviews } from '@/lib/code-reviews/dispatch/dispatch-pending-reviews';
import { getBotUserId } from '@/lib/bot-users/bot-user-service';
import type { CloudAgentCodeReview } from '@kilocode/db/schema';

/**
 * Re-creates the PR gate check (GitHub Check Run / GitLab commit status)
 * after a review has been reset for retry. Without this, `updatePRGateCheck()`
 * would be a no-op for all subsequent status callbacks because `check_run_id`
 * was cleared during reset.
 */
async function recreatePRGateCheck(review: CloudAgentCodeReview) {
  if (!review.platform_integration_id) return;

  const integration = await getIntegrationById(review.platform_integration_id);
  if (!integration) return;

  const platform = review.platform || 'github';
  const detailsUrl = `${APP_URL}/code-reviews/${review.id}`;

  if (platform === 'github' && integration.platform_installation_id) {
    const appType = integration.github_app_type ?? 'standard';
    if (appType === 'lite') return;

    const [repoOwner, repoName] = review.repo_full_name.split('/');
    const checkRunId = await createCheckRun(
      integration.platform_installation_id,
      repoOwner,
      repoName,
      review.head_sha,
      {
        detailsUrl,
        output: { title: 'Kilo Code Review queued', summary: 'Waiting for a review slot...' },
      },
      appType
    );
    try {
      await updateCheckRunId(review.id, checkRunId);
    } catch (dbError) {
      // Cancel the orphaned check run so it doesn't block merging
      try {
        await updateCheckRun(
          integration.platform_installation_id,
          repoOwner,
          repoName,
          checkRunId,
          { status: 'completed', conclusion: 'cancelled' }
        );
        logExceptInTest(
          `[retrigger] Cancelled orphaned check run ${checkRunId.toString()} for ${review.repo_full_name}#${review.pr_number}`
        );
      } catch (cancelError) {
        logExceptInTest('[retrigger] Failed to cancel orphaned check run:', cancelError);
      }
      throw dbError;
    }
    logExceptInTest(
      `[retrigger] Created check run ${checkRunId.toString()} for ${review.repo_full_name}#${review.pr_number}`
    );
  } else if (platform === PLATFORM.GITLAB) {
    const storedPrat = review.platform_project_id
      ? getStoredProjectAccessToken(integration, review.platform_project_id)
      : null;
    const accessToken = storedPrat ? storedPrat.token : await getValidGitLabToken(integration);
    const metadata = integration.metadata as { gitlab_instance_url?: string } | null;
    const instanceUrl = metadata?.gitlab_instance_url || 'https://gitlab.com';

    await setCommitStatus(
      accessToken,
      review.platform_project_id ?? review.repo_full_name,
      review.head_sha,
      'pending',
      { targetUrl: detailsUrl, description: 'Kilo Code Review queued' },
      instanceUrl
    );
    logExceptInTest(
      `[retrigger] Set commit status 'pending' on ${review.repo_full_name}!${review.pr_number}`
    );
  }
}

export const codeReviewRouter = createTRPCRouter({
  /**
   * List code reviews for an organization
   * Requires organization membership
   */
  listForOrganization: organizationMemberProcedure
    .input(ListCodeReviewsInputSchema.omit({ organizationId: true }))
    .query(async ({ input, ctx }) => {
      try {
        // organizationId comes from organizationMemberProcedure's input
        // TypeScript doesn't know about it due to .omit(), but it exists at runtime
        const fullInput = input as typeof input & { organizationId: string };

        const owner: Owner = {
          type: 'org',
          id: fullInput.organizationId,
          userId: ctx.user.id,
        };

        const limit = fullInput.limit ?? DEFAULT_LIST_LIMIT;
        const offset = fullInput.offset ?? 0;

        const [reviews, total] = await Promise.all([
          listCodeReviews({
            owner,
            limit,
            offset,
            status: fullInput.status,
            repoFullName: fullInput.repoFullName,
            platform: fullInput.platform,
          }),
          countCodeReviews({
            owner,
            status: fullInput.status,
            repoFullName: fullInput.repoFullName,
            platform: fullInput.platform,
          }),
        ]);

        const response: ListCodeReviewsResponse = {
          reviews,
          total,
          hasMore: offset + reviews.length < total,
        };

        return successResult(response);
      } catch (error) {
        return failureResult(
          error instanceof Error ? error.message : 'Failed to list code reviews'
        );
      }
    }),

  /**
   * List code reviews for the current user (personal)
   */
  listForUser: baseProcedure
    .input(ListCodeReviewsForUserInputSchema)
    .query(async ({ input, ctx }) => {
      try {
        const owner: Owner = {
          type: 'user',
          id: ctx.user.id,
          userId: ctx.user.id,
        };

        const limit = input.limit ?? DEFAULT_LIST_LIMIT;
        const offset = input.offset ?? 0;

        const [reviews, total] = await Promise.all([
          listCodeReviews({
            owner,
            limit,
            offset,
            status: input.status,
            repoFullName: input.repoFullName,
            platform: input.platform,
          }),
          countCodeReviews({
            owner,
            status: input.status,
            repoFullName: input.repoFullName,
            platform: input.platform,
          }),
        ]);

        const response: ListCodeReviewsResponse = {
          reviews,
          total,
          hasMore: offset + reviews.length < total,
        };

        return successResult(response);
      } catch (error) {
        return failureResult(
          error instanceof Error ? error.message : 'Failed to list code reviews'
        );
      }
    }),

  /**
   * Get a specific code review by ID
   * Verifies user ownership
   */
  get: baseProcedure.input(GetCodeReviewInputSchema).query(async ({ input, ctx }) => {
    try {
      const review = await getCodeReviewById(input.reviewId);

      if (!review) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Code review not found',
        });
      }

      // Authorization check based on owner type
      if (review.owned_by_organization_id) {
        // Organization review: verify user is org member
        await ensureOrganizationAccess(ctx, review.owned_by_organization_id);
      } else if (review.owned_by_user_id) {
        // Personal review: verify user owns it
        if (review.owned_by_user_id !== ctx.user.id) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You do not have access to this code review',
          });
        }
      } else {
        // Should not happen, but handle edge case
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Invalid review ownership data',
        });
      }

      return successResult({ review });
    } catch (error) {
      if (error instanceof TRPCError) {
        throw error;
      }
      return failureResult(error instanceof Error ? error.message : 'Failed to get code review');
    }
  }),

  /**
   * Cancel a code review
   * For running/queued reviews: calls the worker to stop execution and interrupt the cloud agent session
   * For pending reviews: just updates DB status (not dispatched to worker yet)
   */
  cancel: baseProcedure.input(CancelCodeReviewInputSchema).mutation(async ({ input, ctx }) => {
    try {
      const review = await getCodeReviewById(input.reviewId);

      if (!review) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Code review not found',
        });
      }

      // Authorization check based on owner type
      if (review.owned_by_organization_id) {
        // Organization review: verify user is org member
        await ensureOrganizationAccess(ctx, review.owned_by_organization_id);
      } else if (review.owned_by_user_id) {
        // Personal review: verify user owns it
        if (review.owned_by_user_id !== ctx.user.id) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You do not have access to this code review',
          });
        }
      } else {
        // Should not happen, but handle edge case
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Invalid review ownership data',
        });
      }

      // Don't allow cancelling already completed/failed/cancelled/interrupted reviews
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(review.status)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Cannot cancel a review that is already ${review.status}`,
        });
      }

      // For running or queued reviews, call the worker to trigger full interrupt chain
      // This will: stop stream processing, update DB, and interrupt cloud agent session (kill processes)
      if (['running', 'queued'].includes(review.status)) {
        try {
          await codeReviewWorkerClient.cancelReview(input.reviewId, 'Cancelled by user');
          // Worker updates DB status and interrupts cloud agent session
          return successResult({ message: 'Code review cancelled successfully' });
        } catch (workerError) {
          // If worker call fails, still update DB status as fallback
          console.error('Worker cancel failed, updating DB directly:', workerError);
          await cancelCodeReview(input.reviewId);
          return successResult({ message: 'Code review cancelled (worker unreachable)' });
        }
      }

      // For pending reviews (not yet dispatched to worker), just update DB
      await cancelCodeReview(input.reviewId);

      return successResult({ message: 'Code review cancelled successfully' });
    } catch (error) {
      if (error instanceof TRPCError) {
        throw error;
      }
      return failureResult(error instanceof Error ? error.message : 'Failed to cancel code review');
    }
  }),

  /**
   * Retrigger a failed, cancelled, or interrupted code review
   * Resets status to 'pending' and dispatches for processing
   */
  retrigger: baseProcedure
    .input(RetriggerCodeReviewInputSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const review = await getCodeReviewById(input.reviewId);

        if (!review) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Code review not found',
          });
        }

        // Authorization check based on owner type
        if (review.owned_by_organization_id) {
          // Organization review: verify user is org member
          await ensureOrganizationAccess(ctx, review.owned_by_organization_id);
        } else if (review.owned_by_user_id) {
          // Personal review: verify user owns it
          if (review.owned_by_user_id !== ctx.user.id) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'You do not have access to this code review',
            });
          }
        } else {
          // Should not happen, but handle edge case
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Invalid review ownership data',
          });
        }

        // Allow retriggering failed, cancelled, and interrupted reviews
        const retriggableStatuses = ['failed', 'cancelled', 'interrupted'];
        if (!retriggableStatuses.includes(review.status)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Cannot retrigger a review that is ${review.status}. Only failed, cancelled, or interrupted reviews can be retriggered.`,
          });
        }

        // Reset the review for retry
        await resetCodeReviewForRetry(input.reviewId);

        // Re-create PR gate check so status callbacks can update it
        try {
          await recreatePRGateCheck(review);
        } catch (gateError) {
          // Non-blocking — the review still retries even if the gate check fails
          logExceptInTest('[retrigger] Failed to re-create PR gate check:', gateError);
        }

        // Build owner object for dispatch.
        // For org reviews, use the bot user ID so feature flags (e.g. code-review-cloud-agent-next)
        // evaluate consistently regardless of which human triggers the retrigger.
        let owner: Owner;
        if (review.owned_by_organization_id) {
          const botUserId = await getBotUserId(review.owned_by_organization_id, 'code-review');
          owner = {
            type: 'org',
            id: review.owned_by_organization_id,
            userId: botUserId ?? ctx.user.id,
          };
        } else {
          owner = { type: 'user', id: review.owned_by_user_id as string, userId: ctx.user.id };
        }

        // Try to dispatch the review
        await tryDispatchPendingReviews(owner);

        return successResult({ message: 'Code review retriggered successfully' });
      } catch (error) {
        if (error instanceof TRPCError) {
          throw error;
        }
        return failureResult(
          error instanceof Error ? error.message : 'Failed to retrigger code review'
        );
      }
    }),

  /**
   * Get events for a code review (SSE/cloud-agent flow, polling-based)
   * Used when the review is NOT using cloud-agent-next.
   * Verifies user has access to the review:
   * - For org reviews: user must be org member
   * - For personal reviews: user must be the owner
   */
  getReviewEvents: baseProcedure
    .input(
      z.object({
        reviewId: z.string().uuid(),
      })
    )
    .query(async ({ input, ctx }) => {
      try {
        const review = await getCodeReviewById(input.reviewId);

        if (!review) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Code review not found',
          });
        }

        // Authorization check based on owner type
        if (review.owned_by_organization_id) {
          await ensureOrganizationAccess(ctx, review.owned_by_organization_id);
        } else if (review.owned_by_user_id) {
          if (review.owned_by_user_id !== ctx.user.id) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'You do not have access to this code review',
            });
          }
        } else {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Invalid review ownership data',
          });
        }

        // Fetch events from worker (server-side, auth token stays secure)
        const events = await codeReviewWorkerClient.getReviewEvents(input.reviewId);

        return successResult({ events });
      } catch (error) {
        if (error instanceof TRPCError) {
          throw error;
        }
        return failureResult(
          error instanceof Error ? error.message : 'Failed to fetch review events'
        );
      }
    }),

  /**
   * Get stream info for a code review (for WebSocket streaming via cloud-agent-next)
   * Returns the cloudAgentSessionId and organizationId so the frontend can
   * get a stream ticket and connect to cloud-agent-next's WebSocket.
   *
   * Verifies user has access to the review:
   * - For org reviews: user must be org member
   * - For personal reviews: user must be the owner
   */
  getReviewStreamInfo: baseProcedure
    .input(
      z.object({
        reviewId: z.string().uuid(),
      })
    )
    .query(async ({ input, ctx }) => {
      try {
        const review = await getCodeReviewById(input.reviewId);

        if (!review) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Code review not found',
          });
        }

        // Authorization check based on owner type
        if (review.owned_by_organization_id) {
          await ensureOrganizationAccess(ctx, review.owned_by_organization_id);
        } else if (review.owned_by_user_id) {
          if (review.owned_by_user_id !== ctx.user.id) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'You do not have access to this code review',
            });
          }
        } else {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Invalid review ownership data',
          });
        }

        return successResult({
          cloudAgentSessionId: review.session_id ?? null,
          organizationId: review.owned_by_organization_id ?? undefined,
          status: review.status,
          agentVersion: review.agent_version ?? 'v1',
        });
      } catch (error) {
        if (error instanceof TRPCError) {
          throw error;
        }
        return failureResult(
          error instanceof Error ? error.message : 'Failed to get review stream info'
        );
      }
    }),
});
