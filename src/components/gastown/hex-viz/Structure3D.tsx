'use client';

/**
 * A structure (building, tree, crate, etc.) placed on a hex tile.
 * Supports glow effects, labels, and click interaction.
 */

import { useRef, useState, useCallback } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { StructurePlacement } from './types';
import { hexToWorld, rotationToRadians, LEVEL_HEIGHT, TILE_SURFACE_Y } from './hex-math';

type Structure3DProps = {
  placement: StructurePlacement;
  geometries: Map<string, THREE.BufferGeometry>;
  material: THREE.Material;
  onSelect?: (placement: StructurePlacement) => void;
};

export function Structure3D({ placement, geometries, material, onSelect }: Structure3DProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = useState(false);
  const geometry = geometries.get(placement.meshName);

  const handleClick = useCallback(
    (e: ThreeEvent<MouseEvent>) => {
      e.stopPropagation();
      if (onSelect && placement.linkedObjectId) {
        onSelect(placement);
      }
    },
    [onSelect, placement]
  );

  // Animated structures (working agents, fires)
  useFrame(({ clock }) => {
    if (!meshRef.current) return;
    if (placement.animate) {
      if (placement.kind === 'windmill') {
        // Spin Y rotation
        meshRef.current.rotation.y += 0.01;
      } else if (placement.kind === 'fire') {
        // Bob up and down
        const baseY = placement.elevation * LEVEL_HEIGHT + TILE_SURFACE_Y;
        meshRef.current.position.y = baseY + Math.sin(clock.elapsedTime * 3) * 0.05;
      } else if (placement.kind === 'cottage' || placement.kind === 'town-hall') {
        // Gentle glow pulse for working agents
        const scale = 1.0 + Math.sin(clock.elapsedTime * 2) * 0.02;
        meshRef.current.scale.set(scale, scale, scale);
      }
    }
  });

  if (!geometry) {
    // Fallback: render a simple colored box for structures without GLB meshes
    return <FallbackStructure placement={placement} onSelect={onSelect} />;
  }

  const [x, , z] = hexToWorld(placement.col, placement.row);
  const y = placement.elevation * LEVEL_HEIGHT + TILE_SURFACE_Y;
  const rotation = rotationToRadians(placement.rotation);

  return (
    <group position={[x, y, z]}>
      <mesh
        ref={meshRef}
        geometry={geometry}
        material={material}
        rotation={[0, rotation, 0]}
        castShadow
        onClick={handleClick}
        onPointerOver={() => setHovered(true)}
        onPointerOut={() => setHovered(false)}
      />
      {/* Glow indicator */}
      {placement.glow && (
        <pointLight
          color={new THREE.Color(placement.glow[0], placement.glow[1], placement.glow[2])}
          intensity={hovered ? 2.0 : 0.5}
          distance={2}
          position={[0, 0.5, 0]}
        />
      )}
      {/* Label on hover */}
      {hovered && placement.label && (
        <Html
          position={[0, 1.5, 0]}
          center
          style={{
            pointerEvents: 'none',
            userSelect: 'none',
          }}
        >
          <div className="rounded-md bg-gray-900/90 px-2 py-1 text-xs whitespace-nowrap text-white shadow-lg">
            <div className="font-medium">{placement.label}</div>
            {placement.linkedObjectType && (
              <div className="text-[10px] text-gray-400">{placement.linkedObjectType}</div>
            )}
          </div>
        </Html>
      )}
    </group>
  );
}

// ── Fallback for missing meshes ────────────────────────────────────────

function FallbackStructure({
  placement,
  onSelect,
}: {
  placement: StructurePlacement;
  onSelect?: (placement: StructurePlacement) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [x, , z] = hexToWorld(placement.col, placement.row);
  const y = placement.elevation * LEVEL_HEIGHT + TILE_SURFACE_Y;

  const color = placement.glow
    ? new THREE.Color(placement.glow[0], placement.glow[1], placement.glow[2])
    : kindColor(placement.kind);

  const size = kindSize(placement.kind);

  const handleClick = useCallback(
    (e: ThreeEvent<MouseEvent>) => {
      e.stopPropagation();
      if (onSelect && placement.linkedObjectId) {
        onSelect(placement);
      }
    },
    [onSelect, placement]
  );

  return (
    <group position={[x, y, z]}>
      <mesh
        castShadow
        onClick={handleClick}
        onPointerOver={() => setHovered(true)}
        onPointerOut={() => setHovered(false)}
      >
        <boxGeometry args={[size[0], size[1], size[2]]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={hovered ? 0.4 : 0.1}
        />
      </mesh>
      {placement.glow && (
        <pointLight
          color={color}
          intensity={hovered ? 2.0 : 0.5}
          distance={2}
          position={[0, size[1], 0]}
        />
      )}
      {hovered && placement.label && (
        <Html position={[0, size[1] + 0.5, 0]} center style={{ pointerEvents: 'none' }}>
          <div className="rounded-md bg-gray-900/90 px-2 py-1 text-xs whitespace-nowrap text-white shadow-lg">
            <div className="font-medium">{placement.label}</div>
            {placement.linkedObjectType && (
              <div className="text-[10px] text-gray-400">{placement.linkedObjectType}</div>
            )}
          </div>
        </Html>
      )}
    </group>
  );
}

function kindColor(kind: StructurePlacement['kind']): THREE.Color {
  switch (kind) {
    case 'town-hall':
      return new THREE.Color(0xdaa520);
    case 'cottage':
      return new THREE.Color(0x8b4513);
    case 'windmill':
      return new THREE.Color(0x696969);
    case 'market':
      return new THREE.Color(0x228b22);
    case 'crate':
      return new THREE.Color(0xd2691e);
    case 'bridge':
      return new THREE.Color(0x808080);
    case 'fire':
      return new THREE.Color(0xff4500);
    case 'tree':
      return new THREE.Color(0x2e8b57);
    case 'flag':
      return new THREE.Color(0x4169e1);
  }
}

function kindSize(kind: StructurePlacement['kind']): [number, number, number] {
  switch (kind) {
    case 'town-hall':
      return [0.8, 1.2, 0.8];
    case 'cottage':
      return [0.4, 0.5, 0.4];
    case 'windmill':
      return [0.5, 1.0, 0.5];
    case 'market':
      return [0.6, 0.4, 0.6];
    case 'crate':
      return [0.15, 0.15, 0.15];
    case 'bridge':
      return [0.8, 0.2, 0.3];
    case 'fire':
      return [0.2, 0.4, 0.2];
    case 'tree':
      return [0.3, 0.6, 0.3];
    case 'flag':
      return [0.2, 1.0, 0.2];
  }
}
