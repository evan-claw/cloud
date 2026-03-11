'use client';

/**
 * Client component for the 3D hex visualization page.
 *
 * Renders the GastownHexScene with live data from the Town DO,
 * plus an overlay with connection status and a detail panel
 * for selected structures.
 */

import { useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { useTownSnapshot } from '@/components/gastown/hex-viz/use-town-snapshot';
import type { StructurePlacement, TownSnapshot } from '@/components/gastown/hex-viz/types';
import { useDrawerStack } from '@/components/gastown/DrawerStack';

// Dynamic import of the 3D scene to avoid SSR issues with Three.js
const GastownHexScene = dynamic(
  () =>
    import('@/components/gastown/hex-viz/GastownHexScene').then(mod => ({
      default: mod.GastownHexScene,
    })),
  { ssr: false }
);

type HexVizPageClientProps = {
  townId: string;
};

export function HexVizPageClient({ townId }: HexVizPageClientProps) {
  const { snapshot, connected, loading } = useTownSnapshot(townId);
  const [selectedStructure, setSelectedStructure] = useState<StructurePlacement | null>(null);
  const { push } = useDrawerStack();

  const handleStructureSelect = useCallback(
    (structure: StructurePlacement) => {
      setSelectedStructure(structure);

      // Open the appropriate drawer based on the linked object type.
      // Both agent and bead panels require a real rigId for their
      // rig-scoped tRPC queries.
      if (structure.linkedObjectId && structure.linkedObjectType && structure.linkedRigId) {
        switch (structure.linkedObjectType) {
          case 'agent':
            push({
              type: 'agent',
              agentId: structure.linkedObjectId,
              rigId: structure.linkedRigId,
            });
            break;
          case 'bead':
            push({ type: 'bead', beadId: structure.linkedObjectId, rigId: structure.linkedRigId });
            break;
        }
      }
    },
    [push]
  );

  if (loading) {
    return (
      <div className="flex h-[calc(100vh-340px)] items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          <div className="text-sm text-white/60">Loading town data...</div>
        </div>
      </div>
    );
  }

  // Empty state: show the scene with a minimal snapshot
  const displaySnapshot: TownSnapshot = snapshot ?? {
    townId,
    rigs: [],
    agents: [],
    beads: [],
    convoys: [],
    recentEvents: [],
  };

  return (
    <div className="relative h-[calc(100vh-340px)]">
      {/* 3D Hex Scene */}
      <GastownHexScene
        snapshot={displaySnapshot}
        onStructureSelect={handleStructureSelect}
        className="h-full w-full"
      />

      {/* Overlay: Connection status */}
      <div className="absolute top-4 left-4 flex items-center gap-2 rounded-lg bg-black/60 px-3 py-2 backdrop-blur-sm">
        <div className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-amber-400'}`} />
        <span className="text-xs text-white/80">{connected ? 'Live' : 'Reconnecting...'}</span>
      </div>

      {/* Overlay: Town info */}
      <div className="absolute top-4 right-4 rounded-lg bg-black/60 px-4 py-3 backdrop-blur-sm">
        <div className="text-xs text-white/60">Town</div>
        <div className="text-sm font-medium text-white">{townId.slice(0, 8)}...</div>
        <div className="mt-1 flex gap-3 text-xs text-white/60">
          <span>{displaySnapshot.rigs.length} rigs</span>
          <span>{displaySnapshot.agents.length} agents</span>
          <span>{displaySnapshot.beads.filter(b => b.status !== 'closed').length} open beads</span>
        </div>
      </div>

      {/* Overlay: Selected structure info */}
      {selectedStructure && (
        <div className="absolute bottom-4 left-4 max-w-xs rounded-lg bg-black/70 p-4 backdrop-blur-sm">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium text-white">
              {selectedStructure.label ?? selectedStructure.kind}
            </div>
            <button
              onClick={() => setSelectedStructure(null)}
              className="text-xs text-white/50 hover:text-white"
            >
              x
            </button>
          </div>
          {selectedStructure.linkedObjectType && (
            <div className="mt-1 text-xs text-white/50">
              {selectedStructure.linkedObjectType}: {selectedStructure.linkedObjectId?.slice(0, 8)}
            </div>
          )}
          <div className="mt-1 text-xs text-white/40">
            Hex ({selectedStructure.col}, {selectedStructure.row})
          </div>
        </div>
      )}

      {/* Legend */}
      <div className="absolute right-4 bottom-4 rounded-lg bg-black/60 px-3 py-2 backdrop-blur-sm">
        <div className="flex flex-col gap-1 text-[10px] text-white/60">
          <div className="flex items-center gap-2">
            <div className="h-2 w-2 rounded-full bg-emerald-400" />
            Working
          </div>
          <div className="flex items-center gap-2">
            <div className="h-2 w-2 rounded-full bg-amber-400" />
            Stalled
          </div>
          <div className="flex items-center gap-2">
            <div className="h-2 w-2 rounded-full bg-white/30" />
            Idle
          </div>
          <div className="flex items-center gap-2">
            <div className="h-2 w-2 rounded-full bg-red-400" />
            Dead
          </div>
        </div>
      </div>
    </div>
  );
}
