'use client';

/**
 * The main 3D scene for the Gastown hex visualization.
 *
 * Uses @react-three/fiber (R3F) to render a hex-tiled island representing
 * a Gastown town. Loads KayKit medieval hex tile models from a GLB file,
 * lays out terrain and structures based on town state data, and supports
 * real-time updates via WebSocket.
 */

import { Suspense, useMemo, useCallback, useState, useEffect, useRef } from 'react';
import { Canvas } from '@react-three/fiber';
import {
  OrbitControls,
  Environment,
  useGLTF,
  Html,
  PerspectiveCamera,
  ContactShadows,
} from '@react-three/drei';
import * as THREE from 'three';
import type { TownSnapshot, StructurePlacement, HexWorldLayout } from './types';
import { generateLayout } from './layout-generator';
import { InstancedHexTiles, WaterPlane } from './HexTile3D';
import { Structure3D } from './Structure3D';

// ── GLB model path ─────────────────────────────────────────────────────

const GLB_PATH = '/gastown-viz/models/hex-terrain.glb';

// ── Extract geometries from GLB ────────────────────────────────────────

function useHexGeometries(): Map<string, THREE.BufferGeometry> {
  const gltf = useGLTF(GLB_PATH);

  return useMemo(() => {
    const geometries = new Map<string, THREE.BufferGeometry>();

    gltf.scene.traverse((child: THREE.Object3D) => {
      if (child instanceof THREE.Mesh && child.geometry) {
        // The GLB mesh names are the keys we use in tile/structure definitions.
        // Translate Y by +1 to match the hex-map-wfc convention (surface at y=1).
        const geom = child.geometry.clone();
        geom.translate(0, 1, 0);
        geometries.set(child.name, geom);
      }
    });

    return geometries;
  }, [gltf]);
}

// ── Shared tile material ───────────────────────────────────────────────

function useTileMaterial(): THREE.Material {
  return useMemo(() => {
    return new THREE.MeshStandardMaterial({
      vertexColors: false,
      roughness: 0.8,
      metalness: 0.0,
      color: new THREE.Color(0x7cad5c), // Green grass tone
      flatShading: true,
    });
  }, []);
}

function useStructureMaterial(): THREE.Material {
  return useMemo(() => {
    return new THREE.MeshStandardMaterial({
      vertexColors: false,
      roughness: 0.6,
      metalness: 0.1,
      color: new THREE.Color(0xd4a960), // Warm building tone
      flatShading: true,
    });
  }, []);
}

// ── The 3D world content (rendered inside Canvas) ──────────────────────

type HexWorldProps = {
  layout: HexWorldLayout;
  onStructureSelect?: (structure: StructurePlacement) => void;
};

function HexWorld({ layout, onStructureSelect }: HexWorldProps) {
  const geometries = useHexGeometries();
  const tileMaterial = useTileMaterial();
  const structureMaterial = useStructureMaterial();

  // Separate land tiles from water tiles for different materials
  const landTiles = useMemo(
    () => layout.tiles.filter(t => t.meshName !== 'hex_water'),
    [layout.tiles]
  );

  const waterTiles = useMemo(
    () => layout.tiles.filter(t => t.meshName === 'hex_water'),
    [layout.tiles]
  );

  // Water tile material (blue tone)
  const waterTileMaterial = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(0x3b7dd8),
        roughness: 0.3,
        metalness: 0.1,
        flatShading: true,
        transparent: true,
        opacity: 0.85,
      }),
    []
  );

  return (
    <>
      {/* Environment lighting */}
      <Environment preset="sunset" />
      <ambientLight intensity={0.4} />
      <directionalLight
        position={[15, 20, 10]}
        intensity={1.2}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-far={100}
        shadow-camera-left={-30}
        shadow-camera-right={30}
        shadow-camera-top={30}
        shadow-camera-bottom={-30}
      />

      {/* Camera */}
      <PerspectiveCamera makeDefault position={[0, 30, 25]} fov={30} />
      <OrbitControls
        enablePan
        enableZoom
        enableRotate
        minDistance={10}
        maxDistance={100}
        maxPolarAngle={Math.PI / 2.2}
        target={[0, 0, 0]}
      />

      {/* Water plane (below hex tiles) */}
      <WaterPlane size={80} />

      {/* Land hex tiles */}
      <InstancedHexTiles placements={landTiles} geometries={geometries} material={tileMaterial} />

      {/* Water hex tiles */}
      <InstancedHexTiles
        placements={waterTiles}
        geometries={geometries}
        material={waterTileMaterial}
      />

      {/* Structures (buildings, trees, crates, etc.) */}
      {layout.structures.map((structure, i) => (
        <Structure3D
          key={`${structure.col}-${structure.row}-${structure.kind}-${i}`}
          placement={structure}
          geometries={geometries}
          material={structureMaterial}
          onSelect={onStructureSelect}
        />
      ))}

      {/* Ground contact shadows for depth */}
      <ContactShadows position={[0, 0, 0]} opacity={0.3} blur={2} far={30} />

      {/* Fog for atmosphere */}
      <fog attach="fog" args={['#87CEEB', 40, 100]} />
    </>
  );
}

// ── Loading fallback ───────────────────────────────────────────────────

function LoadingIndicator() {
  return (
    <Html center>
      <div className="flex flex-col items-center gap-2 text-white">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white border-t-transparent" />
        <div className="text-sm">Loading hex world...</div>
      </div>
    </Html>
  );
}

// ── Public component ───────────────────────────────────────────────────

type GastownHexSceneProps = {
  snapshot: TownSnapshot;
  onStructureSelect?: (structure: StructurePlacement) => void;
  className?: string;
};

export function GastownHexScene({ snapshot, onStructureSelect, className }: GastownHexSceneProps) {
  const layout = useMemo(() => generateLayout(snapshot), [snapshot]);

  return (
    <div className={className ?? 'h-full w-full'}>
      <Canvas
        shadows
        gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.2 }}
        style={{ background: 'linear-gradient(180deg, #87CEEB 0%, #5BA0D0 50%, #2a6fa8 100%)' }}
      >
        <Suspense fallback={<LoadingIndicator />}>
          <HexWorld layout={layout} onStructureSelect={onStructureSelect} />
        </Suspense>
      </Canvas>
    </div>
  );
}

// Preload the GLB so it's cached when the component mounts
useGLTF.preload(GLB_PATH);
