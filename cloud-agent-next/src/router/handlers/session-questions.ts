import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { getSandbox } from '@cloudflare/sandbox';
import { logger, withLogTags } from '../../logger.js';
import { generateSandboxId } from '../../sandbox-id.js';
import type { SessionId, SandboxId, Env } from '../../types.js';
import { SessionService, fetchSessionMetadata } from '../../session-service.js';
import { protectedProcedure } from '../auth.js';
import { sessionIdSchema } from '../schemas.js';
import { findWrapperForSession } from '../../kilo/wrapper-manager.js';
import { WrapperClient, WrapperNoJobError } from '../../kilo/wrapper-client.js';
import { withDORetry } from '../../utils/do-retry.js';
import type { CloudAgentSession } from '../../persistence/CloudAgentSession.js';
import type { StartExecutionV2Result } from '../../execution/types.js';

async function resolveWrapperClient(opts: {
  sessionId: SessionId;
  userId: string;
  env: Env;
  authToken: string;
}): Promise<WrapperClient> {
  const { sessionId, userId, env, authToken } = opts;

  const metadata = await fetchSessionMetadata(env, userId, sessionId);
  if (!metadata) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' });
  }

  const sandboxId: SandboxId = await generateSandboxId(metadata.orgId, userId, metadata.botId);
  const sandbox = getSandbox(env.Sandbox, sandboxId);

  const wrapperInfo = await findWrapperForSession(sandbox, sessionId);
  if (!wrapperInfo) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'No wrapper found for session' });
  }

  const sessionService = new SessionService();
  const context = sessionService.buildContext({
    sandboxId,
    orgId: metadata.orgId,
    userId,
    sessionId,
    upstreamBranch: metadata.upstreamBranch,
    botId: metadata.botId,
  });

  const session = await sessionService.getOrCreateSession(
    sandbox,
    context,
    env,
    authToken,
    metadata.orgId
  );

  return new WrapperClient({ session, port: wrapperInfo.port });
}

function isRecoverableError(error: unknown): boolean {
  return (
    error instanceof WrapperNoJobError || (error instanceof TRPCError && error.code === 'NOT_FOUND')
  );
}

function throwIfStartFailed(result: StartExecutionV2Result): void {
  if (!result.success) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `Recovery failed: ${result.error}`,
    });
  }
}

export function createSessionQuestionHandlers() {
  return {
    answerQuestion: protectedProcedure
      .input(
        z.object({
          sessionId: sessionIdSchema,
          questionId: z.string().min(1),
          answers: z.array(z.array(z.string())),
        })
      )
      .mutation(async ({ input, ctx }) => {
        return withLogTags({ source: 'answerQuestion' }, async () => {
          const sessionId = input.sessionId as SessionId;
          const { userId, env } = ctx;

          logger.setTags({ userId, sessionId });
          logger.info('Answering question', { questionId: input.questionId });

          try {
            const wrapperClient = await resolveWrapperClient({
              sessionId,
              userId,
              env,
              authToken: ctx.authToken,
            });
            const result = await wrapperClient.answerQuestion(input.questionId, input.answers);
            return { success: result.success };
          } catch (error) {
            if (!isRecoverableError(error)) {
              if (error instanceof TRPCError) throw error;
              const errorMsg = error instanceof Error ? error.message : String(error);
              logger.withFields({ error: errorMsg }).error('Failed to answer question');
              throw new TRPCError({
                code: 'INTERNAL_SERVER_ERROR',
                message: `Failed to answer question: ${errorMsg}`,
              });
            }

            // Recovery: wrapper has no job or no wrapper found — run full execution cycle
            logger.info('Recovering: starting full execution cycle for question answer');

            const doKey = `${userId}:${sessionId}`;
            const doId = env.CLOUD_AGENT_SESSION.idFromName(doKey);

            const startResult = await withDORetry<
              DurableObjectStub<CloudAgentSession>,
              StartExecutionV2Result
            >(
              () => env.CLOUD_AGENT_SESSION.get(doId),
              stub =>
                stub.startExecutionV2({
                  kind: 'answerQuestion',
                  userId: userId as `user_${string}`,
                  botId: ctx.botId,
                  questionId: input.questionId,
                  answers: input.answers,
                }),
              'startExecutionV2'
            );

            throwIfStartFailed(startResult);
            return { success: true };
          }
        });
      }),

    rejectQuestion: protectedProcedure
      .input(
        z.object({
          sessionId: sessionIdSchema,
          questionId: z.string().min(1),
        })
      )
      .mutation(async ({ input, ctx }) => {
        return withLogTags({ source: 'rejectQuestion' }, async () => {
          const sessionId = input.sessionId as SessionId;
          const { userId, env } = ctx;

          logger.setTags({ userId, sessionId });
          logger.info('Rejecting question', { questionId: input.questionId });

          try {
            const wrapperClient = await resolveWrapperClient({
              sessionId,
              userId,
              env,
              authToken: ctx.authToken,
            });
            const result = await wrapperClient.rejectQuestion(input.questionId);
            return { success: result.success };
          } catch (error) {
            if (!isRecoverableError(error)) {
              if (error instanceof TRPCError) throw error;
              const errorMsg = error instanceof Error ? error.message : String(error);
              logger.withFields({ error: errorMsg }).error('Failed to reject question');
              throw new TRPCError({
                code: 'INTERNAL_SERVER_ERROR',
                message: `Failed to reject question: ${errorMsg}`,
              });
            }

            // Recovery: wrapper has no job or no wrapper found — run full execution cycle
            logger.info('Recovering: starting full execution cycle for question rejection');

            const doKey = `${userId}:${sessionId}`;
            const doId = env.CLOUD_AGENT_SESSION.idFromName(doKey);

            const startResult = await withDORetry<
              DurableObjectStub<CloudAgentSession>,
              StartExecutionV2Result
            >(
              () => env.CLOUD_AGENT_SESSION.get(doId),
              stub =>
                stub.startExecutionV2({
                  kind: 'rejectQuestion',
                  userId: userId as `user_${string}`,
                  botId: ctx.botId,
                  questionId: input.questionId,
                }),
              'startExecutionV2'
            );

            throwIfStartFailed(startResult);
            return { success: true };
          }
        });
      }),
  };
}
