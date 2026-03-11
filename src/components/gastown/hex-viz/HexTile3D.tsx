'use client';

/**
 * A single hex tile rendered in 3D using a mesh from the loaded GLB.
 */

import { useRef, useMemo, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { HexTilePlacement } from './types';
import { hexToWorld, rotationToRadians, LEVEL_HEIGHT, TILE_SURFACE_Y } from './hex-math';

type HexTile3DProps = {
  placement: HexTilePlacement;
  geometries: Map<string, THREE.BufferGeometry>;
  material: THREE.Material;
};

export function HexTile3D({ placement, geometries, material }: HexTile3DProps) {
  const geometry = geometries.get(placement.meshName);
  if (!geometry) return null;

  const [x, , z] = hexToWorld(placement.col, placement.row);
  const y = placement.elevation * LEVEL_HEIGHT;
  const rotation = rotationToRadians(placement.rotation);

  return (
    <mesh
      geometry={geometry}
      material={material}
      position={[x, y, z]}
      rotation={[0, rotation, 0]}
      receiveShadow
      castShadow
    />
  );
}

// ── Instanced hex tiles (for performance with many tiles) ──────────────

type InstancedHexTilesProps = {
  placements: HexTilePlacement[];
  geometries: Map<string, THREE.BufferGeometry>;
  material: THREE.Material;
};

/**
 * Groups tiles by mesh name and renders each group as an InstancedMesh.
 * Much faster than individual meshes when tile count is high.
 */
export function InstancedHexTiles({ placements, geometries, material }: InstancedHexTilesProps) {
  // Group placements by mesh name
  const groups = useMemo(() => {
    const map = new Map<string, HexTilePlacement[]>();
    for (const p of placements) {
      const existing = map.get(p.meshName);
      if (existing) {
        existing.push(p);
      } else {
        map.set(p.meshName, [p]);
      }
    }
    return map;
  }, [placements]);

  return (
    <>
      {[...groups.entries()].map(([meshName, group]) => {
        const geometry = geometries.get(meshName);
        if (!geometry) return null;
        return (
          <InstancedTileGroup
            key={meshName}
            geometry={geometry}
            material={material}
            placements={group}
          />
        );
      })}
    </>
  );
}

type InstancedTileGroupProps = {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  placements: HexTilePlacement[];
};

function InstancedTileGroup({ geometry, material, placements }: InstancedTileGroupProps) {
  const meshRef = useRef<THREE.InstancedMesh>(null);

  // useEffect (not useMemo) so the ref is attached before we write matrices.
  // useMemo runs during render before the DOM/Three.js objects exist.
  useEffect(() => {
    if (!meshRef.current) return;
    const mesh = meshRef.current;
    const matrix = new THREE.Matrix4();
    const euler = new THREE.Euler();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3(1, 1, 1);

    for (let i = 0; i < placements.length; i++) {
      const p = placements[i];
      const [x, , z] = hexToWorld(p.col, p.row);
      const y = p.elevation * LEVEL_HEIGHT;
      const rot = rotationToRadians(p.rotation);

      position.set(x, y, z);
      euler.set(0, rot, 0);
      quaternion.setFromEuler(euler);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(i, matrix);

      if (p.color) {
        mesh.setColorAt(i, new THREE.Color(p.color[0], p.color[1], p.color[2]));
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [placements]);

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, placements.length]}
      castShadow
      receiveShadow
    />
  );
}

// ── Water plane ────────────────────────────────────────────────────────

type WaterPlaneProps = {
  size: number;
};

export function WaterPlane({ size }: WaterPlaneProps) {
  const meshRef = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    if (meshRef.current) {
      const material = meshRef.current.material as THREE.MeshStandardMaterial;
      // Subtle wave-like animation via opacity oscillation
      material.opacity = 0.7 + Math.sin(clock.elapsedTime * 0.5) * 0.05;
    }
  });

  return (
    <mesh ref={meshRef} position={[0, 0.3, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[size, size]} />
      <meshStandardMaterial
        color="#2a6fa8"
        transparent
        opacity={0.75}
        roughness={0.3}
        metalness={0.1}
      />
    </mesh>
  );
}
