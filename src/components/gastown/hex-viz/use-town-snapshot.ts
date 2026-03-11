'use client';

/**
 * React hook that maintains a live TownSnapshot for the hex visualization.
 *
 * Fetches initial state via tRPC queries, then subscribes to the Town DO
 * status WebSocket for real-time updates.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useGastownTRPC } from '@/lib/gastown/trpc';
import { gastownWsUrl } from '@/lib/gastown/trpc';
import type { GastownOutputs } from '@/lib/gastown/trpc';
import type {
  TownSnapshot,
  AgentSnapshot,
  BeadSnapshot,
  RigSnapshot,
  ConvoySnapshot,
} from './types';

type TRPCAgent = GastownOutputs['gastown']['listAgents'][number];
type TRPCBead = GastownOutputs['gastown']['listBeads'][number];
type TRPCRig = GastownOutputs['gastown']['listRigs'][number];
type TRPCConvoy = GastownOutputs['gastown']['listConvoys'][number];

export function useTownSnapshot(townId: string): {
  snapshot: TownSnapshot | null;
  connected: boolean;
  loading: boolean;
} {
  const trpc = useGastownTRPC();
  const [connected, setConnected] = useState(false);
  const [wsAgents, setWsAgents] = useState<AgentSnapshot[] | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  // ── tRPC queries for initial state ────────────────────────────────

  const rigsQuery = useQuery(trpc.gastown.listRigs.queryOptions({ townId }));
  const rigIds = useMemo(() => (rigsQuery.data ?? []).map((r: TRPCRig) => r.id), [rigsQuery.data]);

  const firstRigId = rigIds[0] ?? '';

  const agentsQuery = useQuery({
    ...trpc.gastown.listAgents.queryOptions({ rigId: firstRigId }),
    enabled: !!firstRigId,
  });

  const beadsQuery = useQuery({
    ...trpc.gastown.listBeads.queryOptions({ rigId: firstRigId }),
    enabled: !!firstRigId,
  });

  const convoysQuery = useQuery(trpc.gastown.listConvoys.queryOptions({ townId }));

  const loading =
    rigsQuery.isLoading || agentsQuery.isLoading || beadsQuery.isLoading || convoysQuery.isLoading;

  // ── WebSocket for live updates ────────────────────────────────────

  const connect = useCallback(() => {
    if (!mountedRef.current) return;
    const url = gastownWsUrl(`/api/towns/${townId}/status/ws`);
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      setConnected(true);
    };

    ws.onmessage = (e: MessageEvent) => {
      if (!mountedRef.current || typeof e.data !== 'string') return;
      try {
        const parsed: unknown = JSON.parse(e.data);
        if (parsed && typeof parsed === 'object') {
          const data = parsed as Record<string, unknown>;

          if ('agents' in data && Array.isArray(data.agents)) {
            const agents: AgentSnapshot[] = (data.agents as Array<Record<string, unknown>>).map(
              (a: Record<string, unknown>) => ({
                id: String(a.id ?? ''),
                rigId: a.rig_id != null ? String(a.rig_id) : null,
                role: (a.role as AgentSnapshot['role']) ?? 'polecat',
                name: String(a.name ?? ''),
                identity: String(a.identity ?? ''),
                status: (a.status as AgentSnapshot['status']) ?? 'idle',
                currentHookBeadId:
                  a.current_hook_bead_id != null ? String(a.current_hook_bead_id) : null,
                lastActivityAt: a.last_activity_at != null ? String(a.last_activity_at) : null,
                statusMessage:
                  a.agent_status_message != null ? String(a.agent_status_message) : null,
              })
            );
            setWsAgents(agents);
          }
        }
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setConnected(false);
      reconnectTimerRef.current = setTimeout(connect, 3_000);
    };

    ws.onerror = () => {
      // Will trigger onclose
    };
  }, [townId]);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close(1000, 'Component unmount');
      wsRef.current = null;
    };
  }, [connect]);

  // ── Assemble the snapshot ─────────────────────────────────────────

  const snapshot = useMemo<TownSnapshot | null>(() => {
    if (!rigsQuery.data) return null;

    const rigs: RigSnapshot[] = (rigsQuery.data as TRPCRig[]).map((r: TRPCRig) => ({
      id: r.id,
      name: r.name,
      gitUrl: r.git_url,
      defaultBranch: r.default_branch,
    }));

    const agents: AgentSnapshot[] =
      wsAgents ??
      ((agentsQuery.data ?? []) as TRPCAgent[]).map((a: TRPCAgent) => ({
        id: a.id,
        rigId: a.rig_id ?? null,
        role: a.role as AgentSnapshot['role'],
        name: a.name,
        identity: a.identity,
        status: a.status as AgentSnapshot['status'],
        currentHookBeadId: a.current_hook_bead_id ?? null,
        lastActivityAt: a.last_activity_at ?? null,
        statusMessage: a.agent_status_message ?? null,
      }));

    const beadsList = (beadsQuery.data ?? []) as TRPCBead[];
    const beads: BeadSnapshot[] = beadsList.map((b: TRPCBead) => ({
      id: b.bead_id,
      rigId: b.rig_id ?? null,
      type: b.type as BeadSnapshot['type'],
      status: b.status as BeadSnapshot['status'],
      title: b.title,
      priority: b.priority as BeadSnapshot['priority'],
      assigneeAgentId: b.assignee_agent_bead_id ?? null,
    }));

    const convoysList = (convoysQuery.data ?? []) as TRPCConvoy[];
    const convoys: ConvoySnapshot[] = convoysList.map((c: TRPCConvoy) => ({
      id: c.id,
      title: c.title,
      status: c.status as ConvoySnapshot['status'],
      totalBeads: c.total_beads ?? 0,
      closedBeads: c.closed_beads ?? 0,
    }));

    return {
      townId,
      rigs,
      agents,
      beads,
      convoys,
      recentEvents: [],
    };
  }, [townId, rigsQuery.data, agentsQuery.data, beadsQuery.data, convoysQuery.data, wsAgents]);

  return { snapshot, connected, loading };
}
