'use client';

// HeroSceneStage — a perspective grid floor + particle-cloud "thinking" cluster
// rendered with Three.js. Matches the swarmagents.codes pitch-deck visual:
// dotted teal grid plane, glowing cloud of agents floating above, slow drift
// for a "model thinking" feel. Pure r3f, no DOM overlay.

import React, { useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';

interface HeroSceneStageProps {
  /** Optional className for the wrapper. */
  className?: string;
  /** Particle density of the cloud (default 1200). */
  cloudCount?: number;
  /** Rows in the grid plane (default 80). */
  gridRows?: number;
  /** Cols in the grid plane (default 200). */
  gridCols?: number;
}

const PRIMARY = new THREE.Color('#3FE7E0');
const ACCENT = new THREE.Color('#67D9FF');
const SOFT = new THREE.Color('#1AC4D8');

/** Perspective dotted grid plane — fades toward the horizon. */
function GridPlane({ rows = 80, cols = 200 }: { rows?: number; cols?: number }) {
  const meshRef = useRef<THREE.InstancedMesh>(null!);
  const total = rows * cols;

  const positions = useMemo(() => {
    const arr: { x: number; z: number; t: number }[] = [];
    const span = 90;
    const depth = 60;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const u = c / (cols - 1) - 0.5; // -0.5..0.5
        const v = r / (rows - 1);       // 0..1
        const x = u * span;
        const z = -v * depth;
        arr.push({ x, z, t: v });
      }
    }
    return arr;
  }, [rows, cols]);

  // Set instance transforms once
  React.useEffect(() => {
    if (!meshRef.current) return;
    const dummy = new THREE.Object3D();
    const colorAttr = new Float32Array(total * 3);
    for (let i = 0; i < total; i++) {
      const p = positions[i];
      // Fade closer to far edge (t=1 is far back)
      const scale = 0.04 + (1 - p.t) * 0.08;
      dummy.position.set(p.x, 0, p.z);
      dummy.scale.set(scale, scale, scale);
      dummy.updateMatrix();
      meshRef.current.setMatrixAt(i, dummy.matrix);

      const col = SOFT.clone().lerp(PRIMARY, 1 - p.t);
      colorAttr[i * 3 + 0] = col.r;
      colorAttr[i * 3 + 1] = col.g;
      colorAttr[i * 3 + 2] = col.b;
    }
    meshRef.current.instanceMatrix.needsUpdate = true;
    meshRef.current.geometry.setAttribute(
      'color',
      new THREE.InstancedBufferAttribute(colorAttr, 3)
    );
    if (meshRef.current.material instanceof THREE.MeshBasicMaterial) {
      meshRef.current.material.vertexColors = true;
    }
  }, [positions, total]);

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, total]} frustumCulled={false}>
      <sphereGeometry args={[1, 6, 6]} />
      <meshBasicMaterial transparent opacity={0.85} toneMapped={false} />
    </instancedMesh>
  );
}

/** Floating particle cloud above the grid — drifts and swells subtly. */
function ParticleCloud({ count = 1200 }: { count?: number }) {
  const pointsRef = useRef<THREE.Points>(null!);

  const { positions, colors, sizes } = useMemo(() => {
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      // Cluster cloud above origin — width emphasized, height moderate
      const t = Math.random();
      const r = Math.pow(Math.random(), 1.7) * 9;        // radial
      const theta = Math.random() * Math.PI * 2;          // around y axis
      const yJitter = (Math.random() - 0.4) * 4;          // vertical spread
      const x = Math.cos(theta) * r * (1 + Math.random() * 0.3);
      const z = Math.sin(theta) * r * 0.55;               // shallower in z
      const y = 4 + Math.pow(1 - t, 0.5) * 5 + yJitter;
      positions[i * 3 + 0] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;

      const col = PRIMARY.clone().lerp(ACCENT, Math.random());
      colors[i * 3 + 0] = col.r;
      colors[i * 3 + 1] = col.g;
      colors[i * 3 + 2] = col.b;

      sizes[i] = 0.06 + Math.random() * 0.16;
    }
    return { positions, colors, sizes };
  }, [count]);

  useFrame((state) => {
    if (!pointsRef.current) return;
    const t = state.clock.elapsedTime;
    pointsRef.current.rotation.y = t * 0.04;
    const mat = pointsRef.current.material as THREE.PointsMaterial;
    if (mat) mat.opacity = 0.85 + Math.sin(t * 0.6) * 0.1;
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          args={[positions, 3]}
        />
        <bufferAttribute
          attach="attributes-color"
          args={[colors, 3]}
        />
      </bufferGeometry>
      <pointsMaterial
        size={0.18}
        sizeAttenuation
        transparent
        opacity={0.9}
        depthWrite={false}
        vertexColors
        blending={THREE.AdditiveBlending}
        toneMapped={false}
      />
    </points>
  );
}

/** Subtle camera drift so the scene feels alive. */
function CameraRig() {
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    state.camera.position.x = Math.sin(t * 0.08) * 0.6;
    state.camera.position.y = 6 + Math.sin(t * 0.05) * 0.25;
    state.camera.lookAt(0, 5.5, -10);
  });
  return null;
}

export function HeroSceneStage({
  className = '',
  cloudCount = 1200,
  gridRows = 80,
  gridCols = 200,
}: HeroSceneStageProps) {
  return (
    <div className={`pointer-events-none ${className}`}>
      <Canvas
        camera={{ position: [0, 6, 14], fov: 55, near: 0.1, far: 200 }}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      >
        <color attach="background" args={[0, 0, 0]} />
        <fog attach="fog" args={['#000000', 22, 60]} />
        <ambientLight intensity={0.6} />
        <CameraRig />
        <GridPlane rows={gridRows} cols={gridCols} />
        <ParticleCloud count={cloudCount} />
      </Canvas>
    </div>
  );
}

export default HeroSceneStage;
