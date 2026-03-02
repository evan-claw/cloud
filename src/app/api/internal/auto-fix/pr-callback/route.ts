/**
 * Internal API Endpoint: Cloud Agent Callback (Auto Fix)
 *
 * Called by:
 * - Cloud Agent (when fix session completes or fails)
 *
 * Process:
 * 1. Receive callback with sessionId and status
 * 2. Find ticket by sessionId
 * 3. If failed/interrupted: Update ticket status and post comment
 * 4. If successful:
 *    - review_comment trigger: notify on original review thread
 *    - label trigger: create GitHub PR and update ticket
 * 5. Trigger dispatch for pending fixes
 *
 * URL: POST /api/internal/auto-fix/pr-callback
 * Protected by internal API secret
 *
 * Note: This callback is invoked by Cloud Agent when execution reaches a terminal state.
 * For label-triggered tickets, this endpoint creates the PR.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getFixTicketBySessionId, updateFixTicketStatus } from '@/lib/auto-fix/db/fix-tickets';
import { tryDispatchPendingFixes } from '@/lib/auto-fix/dispatch/dispatch-pending-fixes';
import { getBotUserId } from '@/lib/bot-users/bot-user-service';
import { logExceptInTest, errorExceptInTest } from '@/lib/utils.server';
import { captureException, captureMessage } from '@sentry/nextjs';
import { INTERNAL_API_SECRET } from '@/lib/config.server';
import { postIssueComment } from '@/lib/auto-fix/github/post-comment';
import { generateGitHubInstallationToken } from '@/lib/integrations/platforms/github/adapter';
import { getIntegrationById } from '@/lib/integrations/db/platform-integrations';
import { handleCommentReply } from '@/lib/auto-fix/github/handle-comment-reply';

type LegacyCallbackPayload = {
  sessionId: string;
  status: 'completed' | 'failed' | 'interrupted';
  errorMessage?: string;
};

type CloudAgentNextCallbackPayload = {
  sessionId?: string;
  cloudAgentSessionId?: string;
  status: 'completed' | 'failed' | 'interrupted';
  errorMessage?: string;
  lastSeenBranch?: string;
};

type CallbackPayload = LegacyCallbackPayload | CloudAgentNextCallbackPayload;

type AutoFixConfigResponse = {
  githubToken?: string;
  config: {
    pr_base_branch: string;
    pr_title_template: string;
    pr_body_template?: string | null;
  };
};

function normalizePayload(raw: CallbackPayload): {
  sessionId?: string;
  status: 'completed' | 'failed' | 'interrupted';
  errorMessage?: string;
  lastSeenBranch?: string;
} {
  return {
    sessionId:
      raw.sessionId ?? ('cloudAgentSessionId' in raw ? raw.cloudAgentSessionId : undefined),
    status: raw.status,
    errorMessage: raw.errorMessage,
    lastSeenBranch: 'lastSeenBranch' in raw ? raw.lastSeenBranch : undefined,
  };
}

export async function POST(req: NextRequest) {
  try {
    // Validate internal API secret
    const secret = req.headers.get('X-Internal-Secret');
    if (!INTERNAL_API_SECRET || secret !== INTERNAL_API_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const payload: CallbackPayload = await req.json();
    const { sessionId, status, errorMessage, lastSeenBranch } = normalizePayload(payload);

    // Validate payload
    if (!sessionId || !status) {
      return NextResponse.json(
        { error: 'Missing required fields: sessionId, status' },
        { status: 400 }
      );
    }

    logExceptInTest('[auto-fix-pr-callback] Received callback', {
      sessionId,
      status,
      hasError: !!errorMessage,
    });

    // Find ticket by sessionId
    const ticket = await getFixTicketBySessionId(sessionId);

    if (!ticket) {
      logExceptInTest('[auto-fix-pr-callback] Ticket not found for session', { sessionId });
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }

    const ticketId = ticket.id;
    const isTerminalState =
      ticket.status === 'completed' || ticket.status === 'failed' || ticket.status === 'cancelled';

    if (isTerminalState) {
      logExceptInTest(
        '[auto-fix-pr-callback] Ticket already in terminal state, skipping callback',
        {
          ticketId,
          sessionId,
          currentStatus: ticket.status,
          requestedStatus: status,
        }
      );
      return NextResponse.json({ success: true, message: 'Ticket already terminal' });
    }

    // Handle failure/interruption
    if (status === 'failed' || status === 'interrupted') {
      logExceptInTest('[auto-fix-pr-callback] Auto-fix execution failed', {
        ticketId,
        sessionId,
        status,
        errorMessage,
      });

      if (ticket.trigger_source === 'review_comment') {
        const replyResult = await handleCommentReply({
          ticketId,
          sessionId,
          outcome: 'failed',
          errorMessage: errorMessage || `Auto-fix execution ${status}`,
        });

        if (!replyResult.ok) {
          throw new Error(`Failed to post review-comment failure reply: ${replyResult.error}`);
        }
      } else {
        // Update ticket to failed
        await updateFixTicketStatus(ticketId, 'failed', {
          errorMessage: errorMessage || `Auto-fix execution ${status}`,
          completedAt: new Date(),
        });
      }

      // Post issue-level failure comment only for issue-triggered tickets.
      // Review-comment-triggered tickets are notified on their original review thread.
      if (ticket.trigger_source !== 'review_comment') {
        try {
          if (ticket.platform_integration_id) {
            const integration = await getIntegrationById(ticket.platform_integration_id);

            if (integration?.platform_installation_id) {
              const tokenData = await generateGitHubInstallationToken(
                integration.platform_installation_id
              );

              await postIssueComment({
                repoFullName: ticket.repo_full_name,
                issueNumber: ticket.issue_number,
                body: `🤖 **Auto-Fix Update**\n\nI attempted to create a pull request to fix this issue, but encountered an error:\n\n\`\`\`\n${errorMessage || 'Unknown error'}\n\`\`\`\n\nThis issue may require manual attention.`,
                githubToken: tokenData.token,
              });

              logExceptInTest('[auto-fix-pr-callback] Posted failure comment', { ticketId });
            }
          }
        } catch (commentError) {
          errorExceptInTest('[auto-fix-pr-callback] Failed to post failure comment:', commentError);
          captureException(commentError, {
            tags: { operation: 'auto-fix-pr-callback', step: 'post-failure-comment' },
            extra: { ticketId, sessionId },
          });
          // Continue - comment failure is not critical
        }
      }

      // Trigger dispatch for pending fixes
      try {
        await triggerDispatch(ticket);
      } catch (triggerError) {
        // Log but don't fail the request - dispatch is not critical
        errorExceptInTest(
          '[auto-fix-pr-callback] Error in triggerDispatch (failure path):',
          triggerError
        );
        captureException(triggerError, {
          tags: { operation: 'auto-fix-pr-callback', step: 'trigger-dispatch-failure' },
          extra: { ticketId, sessionId },
        });
      }

      return NextResponse.json({ success: true });
    }

    // Handle success
    logExceptInTest('[auto-fix-pr-callback] Cloud Agent session completed successfully', {
      ticketId,
      sessionId,
    });

    if (ticket.trigger_source === 'review_comment') {
      const replyResult = await handleCommentReply({
        ticketId,
        sessionId,
        outcome: 'success',
        prBranch: lastSeenBranch,
      });

      if (!replyResult.ok) {
        throw new Error(`Failed to post review-comment success reply: ${replyResult.error}`);
      }
    } else {
      await createIssueFixPullRequest(req, {
        ticketId,
        sessionId,
        branchName: lastSeenBranch,
      });
    }

    // Trigger dispatch for pending fixes
    try {
      await triggerDispatch(ticket);
    } catch (triggerError) {
      // Log but don't fail the request - dispatch is not critical
      errorExceptInTest(
        '[auto-fix-pr-callback] Error in triggerDispatch (success path):',
        triggerError
      );
      captureException(triggerError, {
        tags: { operation: 'auto-fix-pr-callback', step: 'trigger-dispatch-success' },
        extra: { ticketId, sessionId },
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    errorExceptInTest('[auto-fix-pr-callback] Error processing callback:', error);
    captureException(error, {
      tags: { source: 'auto-fix-pr-callback-api' },
    });

    return NextResponse.json(
      {
        error: 'Failed to process callback',
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

async function createIssueFixPullRequest(
  req: NextRequest,
  params: {
    ticketId: string;
    sessionId: string;
    branchName?: string;
  }
): Promise<void> {
  const configResponse = await fetch(new URL('/api/internal/auto-fix/config', req.url), {
    method: 'POST',
    headers: {
      'X-Internal-Secret': INTERNAL_API_SECRET,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ticketId: params.ticketId,
    }),
  });

  if (!configResponse.ok) {
    const configError = await configResponse.text();
    const message = `Failed to load auto-fix config for PR creation: ${configResponse.status} ${configResponse.statusText} - ${configError}`;

    if (configResponse.status >= 400 && configResponse.status < 500) {
      await markIssueTicketFailed(params.ticketId, message);
    }

    throw new Error(message);
  }

  const configData = (await configResponse.json()) as AutoFixConfigResponse;

  if (!configData.githubToken) {
    const message = 'Cannot create PR: missing GitHub installation token from auto-fix config';
    await markIssueTicketFailed(params.ticketId, message);
    throw new Error(message);
  }

  const createPrResponse = await fetch(new URL('/api/internal/auto-fix/create-pr', req.url), {
    method: 'POST',
    headers: {
      'X-Internal-Secret': INTERNAL_API_SECRET,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ticketId: params.ticketId,
      sessionId: params.sessionId,
      ...(params.branchName ? { branchName: params.branchName } : {}),
      githubToken: configData.githubToken,
      config: {
        pr_base_branch: configData.config.pr_base_branch,
        pr_title_template: configData.config.pr_title_template,
        pr_body_template: configData.config.pr_body_template,
      },
    }),
  });

  if (!createPrResponse.ok) {
    const createPrError = await createPrResponse.text();
    const message = `Failed to create PR from callback: ${createPrResponse.status} ${createPrResponse.statusText} - ${createPrError}`;

    if (createPrResponse.status >= 400 && createPrResponse.status < 500) {
      await markIssueTicketFailed(params.ticketId, message);
    }

    throw new Error(message);
  }

  logExceptInTest('[auto-fix-pr-callback] Created PR for issue-triggered ticket', {
    ticketId: params.ticketId,
    sessionId: params.sessionId,
    branchName: params.branchName,
  });
}

async function markIssueTicketFailed(ticketId: string, errorMessage: string): Promise<void> {
  await updateFixTicketStatus(ticketId, 'failed', {
    errorMessage,
    completedAt: new Date(),
  });
}

/**
 * Trigger dispatch for pending fixes
 */
async function triggerDispatch(ticket: {
  owned_by_organization_id: string | null;
  owned_by_user_id: string | null;
  id: string;
}): Promise<void> {
  try {
    let owner;
    if (ticket.owned_by_organization_id) {
      const botUserId = await getBotUserId(ticket.owned_by_organization_id, 'auto-fix');
      if (botUserId) {
        owner = {
          type: 'org' as const,
          id: ticket.owned_by_organization_id,
          userId: botUserId,
        };
      } else {
        errorExceptInTest('[auto-fix-pr-callback] Bot user not found for organization', {
          organizationId: ticket.owned_by_organization_id,
          ticketId: ticket.id,
        });
        captureMessage('Bot user missing for organization auto fix', {
          level: 'error',
          tags: { source: 'auto-fix-pr-callback' },
          extra: { organizationId: ticket.owned_by_organization_id, ticketId: ticket.id },
        });
      }
    } else {
      owner = {
        type: 'user' as const,
        id: ticket.owned_by_user_id || '',
        userId: ticket.owned_by_user_id || '',
      };
    }

    if (owner) {
      // Trigger dispatch in background (don't await - fire and forget)
      tryDispatchPendingFixes(owner).catch((dispatchError: Error) => {
        errorExceptInTest('[auto-fix-pr-callback] Error dispatching pending fixes:', dispatchError);
        captureException(dispatchError, {
          tags: { source: 'auto-fix-pr-callback-dispatch' },
          extra: { ticketId: ticket.id, owner },
        });
      });

      logExceptInTest('[auto-fix-pr-callback] Triggered dispatch for pending fixes', {
        ticketId: ticket.id,
        owner,
      });
    }
  } catch (dispatchError) {
    errorExceptInTest('[auto-fix-pr-callback] Error in triggerDispatch:', dispatchError);
    // Don't throw - dispatch failure shouldn't fail the callback
  }
}
