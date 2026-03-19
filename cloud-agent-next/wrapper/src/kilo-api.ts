/**
 * Adapter between the wrapper and the @kilocode/sdk client.
 *
 * Provides a stable `WrapperKiloClient` interface that all wrapper modules use.
 * Session and event subscription methods use the v1 SDK client (passed in from
 * main.ts, which uses createKilo() from the root @kilocode/sdk). Methods only
 * available in the v2 API (permission reply, question reply/reject, commit
 * message) use a v2 client created internally from the same server URL.
 */

import type { KiloClient as SDKClient } from '@kilocode/sdk';
import { createKiloClient as createV2Client } from '@kilocode/sdk/v2';
import { logToFile } from './utils.js';

type SessionClient = {
  create: (args: { body: { title?: string } }) => Promise<{ data?: { id: string } }>;
  get: (args: { path: { id: string } }) => Promise<{ data?: { id: string } }>;
  promptAsync: (args: { path?: { id?: string }; body?: unknown }) => Promise<unknown>;
  abort: (args: { path: { id: string } }) => Promise<unknown>;
  command: (args: {
    path: { id: string };
    body: { command: string; arguments: string };
  }) => Promise<{ data?: unknown }>;
};

type V2Client = {
  session: {
    promptAsync: (args: {
      sessionID: string;
      parts: Array<{ type: 'text'; text: string }>;
      variant?: string;
      model?: { providerID: string; modelID: string };
      system?: string;
      tools?: Record<string, boolean>;
      agent?: string;
    }) => Promise<unknown>;
  };
  permission: {
    reply: (args: { requestID: string; reply: PermissionResponse }) => Promise<unknown>;
  };
  question: {
    reply: (args: { requestID: string; answers: string[][] }) => Promise<unknown>;
    reject: (args: { requestID: string }) => Promise<unknown>;
  };
  commitMessage: {
    generate: (args: { path: string }) => Promise<{ data?: { message: string } }>;
  };
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type KiloServerHandle = {
  url: string;
  close: () => void;
};

/**
 * Permission response type.
 */
export type PermissionResponse = 'always' | 'once' | 'reject';

/**
 * The wrapper's unified kilo client interface.
 * All wrapper modules depend on this type rather than the raw SDK client.
 */
export type WrapperKiloClient = {
  createSession: (opts?: { title?: string }) => Promise<{ id: string }>;
  getSession: (sessionId: string) => Promise<{ id: string }>;
  sendPromptAsync: (opts: {
    sessionId: string;
    parts?: Array<{ type: string; text: string }>;
    prompt?: string;
    variant?: string;
    agent?: string;
    model?: { providerID?: string; modelID: string };
    system?: string;
    tools?: Record<string, boolean>;
  }) => Promise<void>;
  abortSession: (opts: { sessionId: string }) => Promise<boolean>;
  sendCommand: (opts: { sessionId: string; command: string; args?: string }) => Promise<unknown>;
  answerPermission: (permissionId: string, response: PermissionResponse) => Promise<boolean>;
  answerQuestion: (questionId: string, answers: string[][]) => Promise<boolean>;
  rejectQuestion: (questionId: string) => Promise<boolean>;
  generateCommitMessage: (opts: { path: string }) => Promise<{ message: string }>;

  /** The underlying SDK client — used directly by connection.ts for event subscription */
  readonly sdkClient: SDKClient;
  /** The in-process server URL — for diagnostics */
  readonly serverUrl: string;
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Create a WrapperKiloClient. Session/event operations use the v1 sdkClient
 * (from createKilo()). Permission/question/commitMessage operations use a v2
 * client created from the same server URL, since those APIs are only available
 * in the v2 SDK.
 */
export function createWrapperKiloClient(
  sdkClient: SDKClient,
  serverUrl: string
): WrapperKiloClient {
  logToFile(`creating wrapper kilo client for ${serverUrl}`);
  const sessionClient = sdkClient.session as unknown as SessionClient;
  const createTypedV2Client = createV2Client as unknown as (args: { baseUrl: string }) => V2Client;
  const v2Client = createTypedV2Client({ baseUrl: serverUrl });

  return {
    sdkClient,
    serverUrl,

    createSession: async opts => {
      const result = await sessionClient.create({
        body: { title: opts?.title },
      });
      if (!result.data) {
        throw new Error('Session create returned no data');
      }
      return { id: result.data.id };
    },

    getSession: async sessionId => {
      const result = await sessionClient.get({
        path: { id: sessionId },
      });
      if (!result.data) {
        throw new Error(`Session get returned no data for ${sessionId}`);
      }
      return { id: result.data.id };
    },

    sendPromptAsync: async opts => {
      const textParts: Array<{ type: 'text'; text: string }> = (
        opts.parts ?? (opts.prompt ? [{ type: 'text', text: opts.prompt }] : [])
      ).map(p => ({ type: 'text' as const, text: p.text }));
      // Use v2 client — it supports `variant` (thinking effort); v1 SDK omits it.
      await v2Client.session.promptAsync({
        sessionID: opts.sessionId,
        parts: textParts,
        ...(opts.variant ? { variant: opts.variant } : {}),
        ...(opts.model
          ? {
              model: {
                providerID: opts.model.providerID ?? 'kilo',
                modelID: opts.model.modelID,
              },
            }
          : {}),
        ...(opts.system ? { system: opts.system } : {}),
        ...(opts.tools ? { tools: opts.tools } : {}),
        ...(opts.agent ? { agent: opts.agent } : {}),
      });
    },

    abortSession: async opts => {
      await sessionClient.abort({ path: { id: opts.sessionId } });
      return true;
    },

    sendCommand: async opts => {
      const result = await sessionClient.command({
        path: { id: opts.sessionId },
        body: {
          command: opts.command,
          arguments: opts.args ?? '',
        },
      });
      return result.data;
    },

    answerPermission: async (permissionId, response) => {
      await v2Client.permission.reply({ requestID: permissionId, reply: response });
      return true;
    },

    answerQuestion: async (questionId, answers) => {
      await v2Client.question.reply({ requestID: questionId, answers });
      return true;
    },

    rejectQuestion: async questionId => {
      await v2Client.question.reject({ requestID: questionId });
      return true;
    },

    generateCommitMessage: async opts => {
      const result = await v2Client.commitMessage.generate({ path: opts.path });
      return result.data ?? { message: '' };
    },
  };
}
