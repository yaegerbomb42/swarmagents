'use client';

import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { HierarchyAgent } from '@/lib/swarmHierarchy';
import SwarmTopologyVisualizer from '../swarm/SwarmTopologyVisualizer';

export type SwarmCanvas3DProps = {
  agents: HierarchyAgent[];
  connected?: boolean;
  className?: string;
  particleCount?: number;
  selectedAgentId?: string | null;
  onSelectAgent?: (id: string) => void;
};

function ParticleField({ count = 420 }: { count?: number }) {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 80);
    camera.position.z = 5;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);

    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      positions[i * 3] = (Math.random() - 0.5) * 14;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 8;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 10;
      velocities[i * 3] = (Math.random() - 0.5) * 0.02;
      velocities[i * 3 + 1] = (Math.random() - 0.5) * 0.015;
      velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.02;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      color: 0x22d3ee,
      size: 0.035,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const points = new THREE.Points(geometry, material);
    scene.add(points);

    const resize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (w < 1 || h < 1) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);
    resize();

    let raf = 0;
    const animate = () => {
      const attr = geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      for (let i = 0; i < count; i += 1) {
        const ix = i * 3;
        arr[ix] += velocities[ix];
        arr[ix + 1] += velocities[ix + 1];
        arr[ix + 2] += velocities[ix + 2];
        if (Math.abs(arr[ix]) > 7) velocities[ix] *= -1;
        if (Math.abs(arr[ix + 1]) > 4) velocities[ix + 1] *= -1;
        if (Math.abs(arr[ix + 2]) > 5) velocities[ix + 2] *= -1;
      }
      attr.needsUpdate = true;
      points.rotation.y += 0.0008;
      renderer.render(scene, camera);
      raf = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, [count]);

  return <div ref={mountRef} className="absolute inset-0" aria-hidden data-testid="swarm-particle-field" />;
}

export default function SwarmCanvas3D({
  agents,
  connected = false,
  className = '',
  particleCount = 420,
  selectedAgentId = null,
  onSelectAgent,
}: SwarmCanvas3DProps) {
  const selected = agents.find((a) => a.id === selectedAgentId);
  const liveAgents = agents.filter((a) => a.live).length;

  return (
    <div
      className={`relative w-full h-full min-h-[420px] overflow-hidden ${className}`}
      data-testid="swarm-canvas-3d"
    >
      <ParticleField count={particleCount} />
      <div className="absolute inset-0">
        <SwarmTopologyVisualizer
          agents={agents}
          connected={connected}
          className="h-full"
          onSelectAgent={onSelectAgent}
        />
      </div>
      <div
        className="absolute top-3 left-3 z-10 rounded-lg border border-white/10 px-3 py-2 text-[10px] font-mono text-zinc-300 space-y-0.5"
        style={{ background: 'rgba(4,4,20,0.72)', backdropFilter: 'blur(12px)' }}
        data-testid="swarm-canvas-hud"
      >
        <div className="text-cyan-300/90 font-semibold tracking-wide">WebGL Swarm</div>
        <div className="text-zinc-500">
          {agents.length} nodes · {liveAgents} live · {connected ? 'SSE' : 'offline'}
        </div>
        {selected && (
          <div className="text-amber-300/90 pt-0.5 border-t border-white/5 mt-1">
            {selected.label} · {selected.activity}
          </div>
        )}
      </div>
      <div
        className="absolute bottom-3 right-3 z-10 rounded-lg border border-cyan-500/20 px-2 py-1 text-[9px] font-mono text-cyan-300/80"
        style={{ background: 'rgba(4,4,20,0.65)', backdropFilter: 'blur(8px)' }}
      >
        particle swarm · {particleCount}
      </div>
    </div>
  );
}
