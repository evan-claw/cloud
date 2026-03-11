/**
 * Hex grid math utilities.
 *
 * Uses pointy-top hexagons with odd-r offset coordinates.
 * World-space units match the KayKit hex tile dimensions:
 *   HEX_WIDTH = 2 (flat-to-flat)
 *   HEX_HEIGHT ≈ 2.31 (point-to-point)
 */

import type { HexCoord, CubeCoord, HexDirection } from './types';

export const HEX_WIDTH = 2;
export const HEX_HEIGHT = 2.31;
export const LEVEL_HEIGHT = 0.5;
export const TILE_SURFACE_Y = 1.0;

// ── Coordinate conversions ─────────────────────────────────────────────

export function offsetToCube(col: number, row: number): CubeCoord {
  const q = col - (row - (row & 1)) / 2;
  const r = row;
  const s = -q - r;
  return { q, r, s };
}

export function cubeToOffset(q: number, r: number): HexCoord {
  const col = q + (r - (r & 1)) / 2;
  const row = r;
  return { col, row };
}

export function cubeDistance(a: CubeCoord, b: CubeCoord): number {
  return Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs(a.s - b.s));
}

// ── World position (for Three.js scene placement) ──────────────────────

export function hexToWorld(col: number, row: number): [number, number, number] {
  const x = col * HEX_WIDTH + (Math.abs(row) % 2) * HEX_WIDTH * 0.5;
  const z = row * HEX_HEIGHT * 0.75;
  return [x, 0, z];
}

export function hexToWorldXZ(col: number, row: number): { x: number; z: number } {
  const x = col * HEX_WIDTH + (Math.abs(row) % 2) * HEX_WIDTH * 0.5;
  const z = row * HEX_HEIGHT * 0.75;
  return { x, z };
}

// ── Neighbor offsets for odd-r pointy-top ──────────────────────────────

const NEIGHBOR_OFFSETS_EVEN: Record<HexDirection, { dx: number; dz: number }> = {
  NE: { dx: 0, dz: -1 },
  E: { dx: 1, dz: 0 },
  SE: { dx: 0, dz: 1 },
  SW: { dx: -1, dz: 1 },
  W: { dx: -1, dz: 0 },
  NW: { dx: -1, dz: -1 },
};

const NEIGHBOR_OFFSETS_ODD: Record<HexDirection, { dx: number; dz: number }> = {
  NE: { dx: 1, dz: -1 },
  E: { dx: 1, dz: 0 },
  SE: { dx: 1, dz: 1 },
  SW: { dx: 0, dz: 1 },
  W: { dx: -1, dz: 0 },
  NW: { dx: 0, dz: -1 },
};

export function getNeighbor(col: number, row: number, dir: HexDirection): HexCoord {
  const offsets = row % 2 === 0 ? NEIGHBOR_OFFSETS_EVEN : NEIGHBOR_OFFSETS_ODD;
  const { dx, dz } = offsets[dir];
  return { col: col + dx, row: row + dz };
}

// ── Hex ring / area enumeration ────────────────────────────────────────

/** All hex coords within `radius` of (centerCol, centerRow), inclusive. */
export function hexesInRadius(centerCol: number, centerRow: number, radius: number): HexCoord[] {
  const center = offsetToCube(centerCol, centerRow);
  const result: HexCoord[] = [];
  for (let q = center.q - radius; q <= center.q + radius; q++) {
    for (let r = center.r - radius; r <= center.r + radius; r++) {
      const s = -q - r;
      if (cubeDistance(center, { q, r, s }) <= radius) {
        result.push(cubeToOffset(q, r));
      }
    }
  }
  return result;
}

/** Hex coords forming a ring at exactly `radius` distance from center. */
export function hexRing(centerCol: number, centerRow: number, radius: number): HexCoord[] {
  if (radius === 0) return [{ col: centerCol, row: centerRow }];
  const center = offsetToCube(centerCol, centerRow);
  const result: HexCoord[] = [];
  for (let q = center.q - radius; q <= center.q + radius; q++) {
    for (let r = center.r - radius; r <= center.r + radius; r++) {
      const s = -q - r;
      if (cubeDistance(center, { q, r, s }) === radius) {
        result.push(cubeToOffset(q, r));
      }
    }
  }
  return result;
}

// ── Rotation ───────────────────────────────────────────────────────────

/** Convert a rotation index (0-5) to radians for Y-axis rotation. */
export function rotationToRadians(rotation: number): number {
  return (rotation * Math.PI) / 3;
}
