'use client';

/**
 * React hook that maintains a live TownSnapshot for the hex visualization.
 *
 * Fetches initial state via tRPC queries (agents + beads for ALL rigs),
 * then subscribes to the Town DO status WebSocket for real-time updates.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useQuery, useQueries } from '@tanstack/react-query';
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
  const rigs = useMemo(() => (rigsQuery.data ?? []) as TRPCRig[], [rigsQuery.data]);

  // Query agents for ALL rigs (useQueries handles dynamic-length arrays)
  const rigAgentQueries = useQueries({
    queries: rigs.map(rig => trpc.gastown.listAgents.queryOptions({ rigId: rig.id })),
  });

  // Query beads for ALL rigs
  const rigBeadQueries = useQueries({
    queries: rigs.map(rig => trpc.gastown.listBeads.queryOptions({ rigId: rig.id })),
  });

  const convoysQuery = useQuery(trpc.gastown.listConvoys.queryOptions({ townId }));

  const agentsLoading = rigAgentQueries.some(q => q.isLoading);
  const beadsLoading = rigBeadQueries.some(q => q.isLoading);
  const loading = rigsQuery.isLoading || agentsLoading || beadsLoading || convoysQuery.isLoading;

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

  // Stabilize the query data arrays so useMemo deps work correctly
  const rigAgentData = rigAgentQueries.map(q => q.data);
  const rigBeadData = rigBeadQueries.map(q => q.data);

  const snapshot = useMemo<TownSnapshot | null>(() => {
    if (!rigsQuery.data) return null;

    const rigSnapshots: RigSnapshot[] = rigs.map((r: TRPCRig) => ({
      id: r.id,
      name: r.name,
      gitUrl: r.git_url,
      defaultBranch: r.default_branch,
    }));

    // Merge agents from all rigs
    const tRPCAgents: AgentSnapshot[] = rigAgentData.flatMap((data, i) => {
      const rig = rigs[i];
      if (!data || !rig) return [];
      return (data as TRPCAgent[]).map((a: TRPCAgent) => ({
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
    });

    // Prefer WebSocket-updated agents when available (they span all rigs)
    const agents = wsAgents ?? tRPCAgents;

    // Merge beads from all rigs
    const beads: BeadSnapshot[] = rigBeadData.flatMap((data, i) => {
      const rig = rigs[i];
      if (!data || !rig) return [];
      return (data as TRPCBead[]).map((b: TRPCBead) => ({
        id: b.bead_id,
        rigId: b.rig_id ?? null,
        type: b.type as BeadSnapshot['type'],
        status: b.status as BeadSnapshot['status'],
        title: b.title,
        priority: b.priority as BeadSnapshot['priority'],
        assigneeAgentId: b.assignee_agent_bead_id ?? null,
      }));
    });

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
      rigs: rigSnapshots,
      agents,
      beads,
      convoys,
      recentEvents: [],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [townId, rigsQuery.data, rigs, rigAgentData, rigBeadData, convoysQuery.data, wsAgents]);

  return { snapshot, connected, loading };
}
