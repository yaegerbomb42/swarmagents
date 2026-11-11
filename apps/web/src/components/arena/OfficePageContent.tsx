'use client';

import { Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { ArenaHUD } from '@/components/arena/ArenaHUD';
import { OfficeScene } from '@/components/arena/OfficeScene';

export default function OfficePageContent() {
  return (
    <>
      <Canvas
        shadows
        camera={{ position: [9, 5, 8], fov: 55, near: 0.1, far: 200 }}
        gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
        dpr={[1, 2]}
        className="absolute inset-0"
      >
        <color attach="background" args={['#040414']} />
        <fog attach="fog" args={['#040414', 16, 60]} />
        <Suspense fallback={null}>
          <OfficeScene />
        </Suspense>
      </Canvas>
      <ArenaHUD />
    </>
  );
}
