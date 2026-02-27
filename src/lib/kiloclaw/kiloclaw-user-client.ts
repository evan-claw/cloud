import 'server-only';

import { KILOCLAW_API_URL } from '@/lib/config.server';
import { KiloClawApiError } from './kiloclaw-internal-client';
import type { UserConfigResponse, PlatformStatusResponse, RestartGatewayResponse } from './types';

/**
 * KiloClaw worker client for user-facing routes.
 * Uses Bearer JWT auth (forwarding the user's token). Server-only.
 */
export class KiloClawUserClient {
  private authToken: string;
  private baseUrl: string;

  constructor(authToken: string) {
    if (!KILOCLAW_API_URL) {
      throw new Error('KILOCLAW_API_URL is not configured');
    }
    this.authToken = authToken;
    this.baseUrl = KILOCLAW_API_URL;
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.authToken}`,
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(
        `KiloClaw API error (${res.status}) ${options?.method ?? 'GET'} ${path}:`,
        body
      );
      throw new KiloClawApiError(res.status);
    }

    return res.json() as Promise<T>;
  }

  async getConfig(): Promise<UserConfigResponse> {
    return this.request('/api/kiloclaw/config');
  }

  async getStatus(): Promise<PlatformStatusResponse> {
    return this.request('/api/kiloclaw/status');
  }

  async restartGateway(options?: { imageTag?: string }): Promise<RestartGatewayResponse> {
    return this.request('/api/admin/gateway/restart', {
      method: 'POST',
      body: options?.imageTag ? JSON.stringify({ imageTag: options.imageTag }) : undefined,
    });
  }
}
