/**
 * Types for the Gastown 3D hex visualization.
 *
 * Maps Gastown domain objects (rigs, agents, beads, convoys)
 * to hex-grid visual representations.
 */

// ── Hex coordinate system (pointy-top, odd-r offset) ───────────────────

export type HexCoord = { col: number; row: number };
export type CubeCoord = { q: number; r: number; s: number };

export const HEX_DIRECTIONS = ['NE', 'E', 'SE', 'SW', 'W', 'NW'] as const;
export type HexDirection = (typeof HEX_DIRECTIONS)[number];

// ── Town state snapshot (from WebSocket or tRPC) ───────────────────────

export type TownSnapshot = {
  townId: string;
  rigs: RigSnapshot[];
  agents: AgentSnapshot[];
  beads: BeadSnapshot[];
  convoys: ConvoySnapshot[];
  recentEvents: EventSnapshot[];
};

export type RigSnapshot = {
  id: string;
  name: string;
  gitUrl: string;
  defaultBranch: string;
};

export type AgentSnapshot = {
  id: string;
  rigId: string | null;
  role: 'polecat' | 'refinery' | 'mayor';
  name: string;
  identity: string;
  status: 'idle' | 'working' | 'stalled' | 'dead';
  currentHookBeadId: string | null;
  lastActivityAt: string | null;
  statusMessage: string | null;
};

export type BeadSnapshot = {
  id: string;
  rigId: string | null;
  type: 'issue' | 'message' | 'escalation' | 'merge_request' | 'convoy' | 'molecule' | 'agent';
  status: 'open' | 'in_progress' | 'closed' | 'failed';
  title: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  assigneeAgentId: string | null;
};

export type ConvoySnapshot = {
  id: string;
  title: string;
  status: 'active' | 'landed';
  totalBeads: number;
  closedBeads: number;
};

export type EventSnapshot = {
  id: string;
  eventType: string;
  message: string;
  timestamp: string;
};

// ── Hex tile placement ─────────────────────────────────────────────────

export type HexTilePlacement = {
  col: number;
  row: number;
  meshName: string;
  rotation: number; // 0-5 (60 degree steps)
  elevation: number; // 0-4
  color?: [number, number, number]; // RGB tint
};

// ── Structure (decoration placed on a hex tile) ────────────────────────

export type StructureKind =
  | 'town-hall'
  | 'cottage'
  | 'windmill'
  | 'market'
  | 'crate'
  | 'bridge'
  | 'fire'
  | 'tree'
  | 'flag';

export type StructurePlacement = {
  col: number;
  row: number;
  kind: StructureKind;
  meshName: string;
  rotation: number;
  elevation: number;
  /** Optional link to a Gastown object for click interaction */
  linkedObjectId?: string;
  linkedObjectType?: 'agent' | 'bead' | 'rig' | 'convoy';
  /** Visual state */
  glow?: [number, number, number]; // RGB glow color
  label?: string;
  animate?: boolean; // e.g., windmill spin, fire flicker
};

// ── District (a rig's region on the hex map) ────────────────────────────

export type District = {
  rigId: string;
  rigName: string;
  centerCol: number;
  centerRow: number;
  radius: number;
  tiles: HexTilePlacement[];
  structures: StructurePlacement[];
};

// ── Full hex world layout ──────────────────────────────────────────────

export type HexWorldLayout = {
  tiles: HexTilePlacement[];
  structures: StructurePlacement[];
  districts: District[];
  waterTiles: HexTilePlacement[];
};
