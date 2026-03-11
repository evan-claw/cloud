/**
 * Transforms a TownSnapshot into a HexWorldLayout.
 *
 * The layout is deterministic given the same snapshot:
 * - Town center is always the Mayor (town hall)
 * - Each rig gets a district placed in a ring around center
 * - Agents become structures (cottages/windmills) within their rig's district
 * - Beads become crates near their assigned agent
 * - Water surrounds the island
 */

import type {
  TownSnapshot,
  RigSnapshot,
  AgentSnapshot,
  BeadSnapshot,
  HexWorldLayout,
  HexTilePlacement,
  StructurePlacement,
  District,
} from './types';
import { hexesInRadius, hexRing, hexToWorldXZ, offsetToCube, cubeDistance } from './hex-math';

// ── District placement ─────────────────────────────────────────────────

/** Positions for rig districts around the center (ring of radius 5 in offset coords). */
const DISTRICT_POSITIONS: Array<{ col: number; row: number }> = [
  { col: 5, row: 0 },
  { col: 3, row: 4 },
  { col: -2, row: 4 },
  { col: -5, row: 0 },
  { col: -2, row: -4 },
  { col: 3, row: -4 },
  // Second ring for towns with 7+ rigs
  { col: 8, row: -3 },
  { col: 8, row: 3 },
  { col: 0, row: 7 },
  { col: -7, row: 4 },
  { col: -7, row: -3 },
  { col: 0, row: -7 },
];

const DISTRICT_RADIUS = 2;
const TOWN_CENTER = { col: 0, row: 0 };

// ── Mesh names from the KayKit hex-terrain.glb ─────────────────────────

const GRASS_MESH = 'hex_grass';
const WATER_MESH = 'hex_water';
const ROAD_STRAIGHT = 'hex_road_A';
const ROAD_CURVE = 'hex_road_B';
const ROAD_END = 'hex_road_M';

// ── Structure mesh names ───────────────────────────────────────────────

const TOWN_HALL_MESH = 'building_townhall_yellow';
const COTTAGE_MESHES = ['building_home_A_yellow', 'building_home_B_yellow'];
const WINDMILL_MESH = 'building_windmill_yellow';
const MARKET_MESH = 'building_market_yellow';
const BLACKSMITH_MESH = 'building_blacksmith_yellow';
const CHURCH_MESH = 'building_church_yellow';
const TOWER_MESH = 'building_tower_A_yellow';
const WELL_MESH = 'building_well_yellow';
const TREE_MESHES = ['tree_single_A', 'tree_single_B', 'tree_C', 'tree_D', 'tree_E'];
const FLAG_MESH = 'building_tower_A_yellow'; // Reuse tower as flag/banner
const HENGE_MESH = 'henge';

// ── Agent status → glow color ──────────────────────────────────────────

function agentStatusGlow(status: AgentSnapshot['status']): [number, number, number] {
  switch (status) {
    case 'working':
      return [0.2, 1.0, 0.3]; // green
    case 'stalled':
      return [1.0, 0.3, 0.1]; // red
    case 'idle':
      return [0.5, 0.5, 0.5]; // gray
    case 'dead':
      return [0.2, 0.2, 0.2]; // dark gray
  }
}

// ── Priority → color tint ──────────────────────────────────────────────

function priorityColor(priority: BeadSnapshot['priority']): [number, number, number] {
  switch (priority) {
    case 'critical':
      return [1.0, 0.84, 0.0]; // gold
    case 'high':
      return [1.0, 0.2, 0.2]; // red
    case 'medium':
      return [0.3, 0.5, 1.0]; // blue
    case 'low':
      return [0.6, 0.6, 0.6]; // gray
  }
}

// ── Seeded pseudo-random (deterministic from ID) ───────────────────────

function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash + ch) | 0;
  }
  return Math.abs(hash);
}

function seededChoice<T>(items: T[], seed: string): T {
  return items[hashCode(seed) % items.length];
}

function seededRotation(seed: string): number {
  return hashCode(seed) % 6;
}

// ── Main layout generator ──────────────────────────────────────────────

export function generateLayout(snapshot: TownSnapshot): HexWorldLayout {
  const allTiles: HexTilePlacement[] = [];
  const allStructures: StructurePlacement[] = [];
  const allDistricts: District[] = [];
  const waterTiles: HexTilePlacement[] = [];
  const occupiedHexes = new Set<string>();

  const hexKey = (col: number, row: number) => `${col},${row}`;
  const markOccupied = (col: number, row: number) => occupiedHexes.add(hexKey(col, row));
  const isOccupied = (col: number, row: number) => occupiedHexes.has(hexKey(col, row));

  // ── 1. Place the Town Center (Mayor's district) ────────────────────

  const mayorAgent = snapshot.agents.find(a => a.role === 'mayor');
  const centerHexes = hexesInRadius(TOWN_CENTER.col, TOWN_CENTER.row, 2);

  for (const hex of centerHexes) {
    allTiles.push({
      col: hex.col,
      row: hex.row,
      meshName: GRASS_MESH,
      rotation: 0,
      elevation: 0,
    });
    markOccupied(hex.col, hex.row);
  }

  // Town Hall at center
  allStructures.push({
    col: TOWN_CENTER.col,
    row: TOWN_CENTER.row,
    kind: 'town-hall',
    meshName: TOWN_HALL_MESH,
    rotation: 0,
    elevation: 0,
    linkedObjectId: mayorAgent?.id,
    linkedObjectType: 'agent',
    glow: mayorAgent ? agentStatusGlow(mayorAgent.status) : [0.5, 0.5, 0.5],
    label: 'Town Hall',
    animate: mayorAgent?.status === 'working',
  });

  // Decorative structures around the town hall
  const centerRing1 = hexRing(TOWN_CENTER.col, TOWN_CENTER.row, 1);
  if (centerRing1.length > 0) {
    allStructures.push({
      col: centerRing1[0].col,
      row: centerRing1[0].row,
      kind: 'tree',
      meshName: WELL_MESH,
      rotation: 0,
      elevation: 0,
      label: 'Well',
    });
  }
  // Add trees on remaining center ring hexes
  for (let i = 1; i < centerRing1.length; i++) {
    const hex = centerRing1[i];
    allStructures.push({
      col: hex.col,
      row: hex.row,
      kind: 'tree',
      meshName: seededChoice(TREE_MESHES, `center-tree-${i}`),
      rotation: seededRotation(`center-tree-rot-${i}`),
      elevation: 0,
    });
  }

  // ── 2. Place Rig Districts ─────────────────────────────────────────

  const rigsByIndex = [...snapshot.rigs];

  for (
    let rigIdx = 0;
    rigIdx < rigsByIndex.length && rigIdx < DISTRICT_POSITIONS.length;
    rigIdx++
  ) {
    const rig = rigsByIndex[rigIdx];
    const pos = DISTRICT_POSITIONS[rigIdx];
    const district = buildRigDistrict(rig, pos, rigIdx, snapshot, markOccupied);
    allDistricts.push(district);
    allTiles.push(...district.tiles);
    allStructures.push(...district.structures);
  }

  // ── 3. Place roads connecting districts to center ──────────────────

  for (const district of allDistricts) {
    const roadTiles = buildRoad(
      TOWN_CENTER.col,
      TOWN_CENTER.row,
      district.centerCol,
      district.centerRow,
      occupiedHexes,
      markOccupied
    );
    allTiles.push(...roadTiles);
  }

  // ── 4. Fill remaining area with water ──────────────────────────────

  const mapRadius = snapshot.rigs.length > 0 ? 10 : 5;
  const allHexes = hexesInRadius(0, 0, mapRadius);
  for (const hex of allHexes) {
    if (!isOccupied(hex.col, hex.row)) {
      const waterTile: HexTilePlacement = {
        col: hex.col,
        row: hex.row,
        meshName: WATER_MESH,
        rotation: 0,
        elevation: 0,
      };
      waterTiles.push(waterTile);
      allTiles.push(waterTile);
      markOccupied(hex.col, hex.row);
    }
  }

  return {
    tiles: allTiles,
    structures: allStructures,
    districts: allDistricts,
    waterTiles,
  };
}

// ── Build a rig district ───────────────────────────────────────────────

function buildRigDistrict(
  rig: RigSnapshot,
  center: { col: number; row: number },
  rigIdx: number,
  snapshot: TownSnapshot,
  markOccupied: (col: number, row: number) => void
): District {
  const tiles: HexTilePlacement[] = [];
  const structures: StructurePlacement[] = [];

  const hexes = hexesInRadius(center.col, center.row, DISTRICT_RADIUS);
  for (const hex of hexes) {
    tiles.push({
      col: hex.col,
      row: hex.row,
      meshName: GRASS_MESH,
      rotation: 0,
      elevation: 0,
    });
    markOccupied(hex.col, hex.row);
  }

  // Flag/banner at district center with rig name
  structures.push({
    col: center.col,
    row: center.row,
    kind: 'flag',
    meshName: FLAG_MESH,
    rotation: seededRotation(rig.id),
    elevation: 0,
    linkedObjectId: rig.id,
    linkedObjectType: 'rig',
    linkedRigId: rig.id,
    label: rig.name,
  });

  // Place agents as structures in the district
  const rigAgents = snapshot.agents.filter(a => a.rigId === rig.id);
  const ring1 = hexRing(center.col, center.row, 1);
  const ring2 = hexRing(center.col, center.row, 2);
  const placementSlots = [...ring1, ...ring2];

  let slotIdx = 0;
  for (const agent of rigAgents) {
    if (slotIdx >= placementSlots.length) break;
    const slot = placementSlots[slotIdx++];

    const isRefinery = agent.role === 'refinery';
    structures.push({
      col: slot.col,
      row: slot.row,
      kind: isRefinery ? 'windmill' : 'cottage',
      meshName: isRefinery ? WINDMILL_MESH : seededChoice(COTTAGE_MESHES, agent.id),
      rotation: seededRotation(agent.id),
      elevation: 0,
      linkedObjectId: agent.id,
      linkedObjectType: 'agent',
      linkedRigId: rig.id,
      glow: agentStatusGlow(agent.status),
      label: agent.name,
      animate: agent.status === 'working',
    });

    // Place crates for beads assigned to this agent
    const agentBeads = snapshot.beads.filter(
      b => b.assigneeAgentId === agent.id && b.status !== 'closed' && b.type === 'issue'
    );
    // Crates go on the same hex as the agent (stacked visually)
    for (const bead of agentBeads.slice(0, 3)) {
      structures.push({
        col: slot.col,
        row: slot.row,
        kind: 'crate',
        meshName: 'rock_single_A', // Using rock as crate placeholder
        rotation: seededRotation(bead.id),
        elevation: 0,
        linkedObjectId: bead.id,
        linkedObjectType: 'bead',
        linkedRigId: rig.id,
        glow: priorityColor(bead.priority),
        label: bead.title.slice(0, 20),
      });
    }
  }

  // Place trees on remaining empty slots
  for (; slotIdx < placementSlots.length; slotIdx++) {
    const slot = placementSlots[slotIdx];
    structures.push({
      col: slot.col,
      row: slot.row,
      kind: 'tree',
      meshName: seededChoice(TREE_MESHES, `${rig.id}-tree-${slotIdx}`),
      rotation: seededRotation(`${rig.id}-tree-rot-${slotIdx}`),
      elevation: 0,
    });
  }

  // Unassigned beads as market stalls
  const unassignedBeads = snapshot.beads.filter(
    b => b.rigId === rig.id && !b.assigneeAgentId && b.status === 'open' && b.type === 'issue'
  );
  if (unassignedBeads.length > 0 && ring1.length > 0) {
    structures.push({
      col: center.col,
      row: center.row,
      kind: 'market',
      meshName: MARKET_MESH,
      rotation: 0,
      elevation: 0,
      label: `${unassignedBeads.length} open`,
    });
  }

  // Escalation beads as fire
  const escalations = snapshot.beads.filter(
    b => b.rigId === rig.id && b.type === 'escalation' && b.status !== 'closed'
  );
  for (const esc of escalations) {
    const fireSlot = placementSlots[hashCode(esc.id) % placementSlots.length];
    structures.push({
      col: fireSlot.col,
      row: fireSlot.row,
      kind: 'fire',
      meshName: 'rock_single_B', // Placeholder — will render as particle effect
      rotation: 0,
      elevation: 0,
      linkedObjectId: esc.id,
      linkedObjectType: 'bead',
      linkedRigId: rig.id,
      glow: [1.0, 0.4, 0.0], // orange
      label: esc.title.slice(0, 20),
      animate: true,
    });
  }

  return {
    rigId: rig.id,
    rigName: rig.name,
    centerCol: center.col,
    centerRow: center.row,
    radius: DISTRICT_RADIUS,
    tiles,
    structures,
  };
}

// ── Road building (simple line interpolation) ──────────────────────────

function buildRoad(
  fromCol: number,
  fromRow: number,
  toCol: number,
  toRow: number,
  occupiedHexes: Set<string>,
  markOccupied: (col: number, row: number) => void
): HexTilePlacement[] {
  const tiles: HexTilePlacement[] = [];
  const from = offsetToCube(fromCol, fromRow);
  const to = offsetToCube(toCol, toRow);
  const dist = cubeDistance(from, to);
  if (dist <= 1) return tiles;

  // Linear interpolation in cube space
  for (let i = 1; i < dist; i++) {
    const t = i / dist;
    const q = Math.round(from.q + (to.q - from.q) * t);
    const r = Math.round(from.r + (to.r - from.r) * t);
    const s = -q - r;

    // Fix rounding: ensure q + r + s === 0
    const qDiff = Math.abs(q - (from.q + (to.q - from.q) * t));
    const rDiff = Math.abs(r - (from.r + (to.r - from.r) * t));
    const sDiff = Math.abs(s - (from.s + (to.s - from.s) * t));

    let fq = q,
      fr = r;
    if (qDiff > rDiff && qDiff > sDiff) {
      fq = -fr - (-fq - fr); // recalc q
    } else if (rDiff > sDiff) {
      fr = -fq - (-fq - fr); // recalc r
    }
    // s is implicit

    // Convert back to offset and check if free
    const col = fq + (fr - (fr & 1)) / 2;
    const row = fr;
    const key = `${col},${row}`;

    if (!occupiedHexes.has(key)) {
      tiles.push({
        col,
        row,
        meshName: ROAD_STRAIGHT,
        rotation: estimateRoadRotation(fromCol, fromRow, toCol, toRow),
        elevation: 0,
      });
      markOccupied(col, row);
    }
  }

  return tiles;
}

function estimateRoadRotation(
  fromCol: number,
  fromRow: number,
  toCol: number,
  toRow: number
): number {
  const dx = toCol - fromCol;
  const dz = toRow - fromRow;
  const angle = Math.atan2(dz, dx);
  // Map angle to nearest 60-degree step (0-5)
  const step = Math.round(angle / (Math.PI / 3));
  return ((step % 6) + 6) % 6;
}
