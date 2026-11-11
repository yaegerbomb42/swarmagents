'use client';

import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { HierarchyAgent } from '@/lib/swarmHierarchy';

export type SwarmTopologyVisualizerProps = {
  agents: HierarchyAgent[];
  connected?: boolean;
  className?: string;
  onSelectAgent?: (id: string) => void;
};

const ACTIVITY_COLOR: Record<HierarchyAgent['activity'], number> = {
  idle: 0x64748b,
  working: 0x34d399,
  communicating: 0x22d3ee,
};

function roleHue(roleId: string): number {
  const palette: Record<string, number> = {
    architect: 0xa78bfa,
    implementer: 0x22d3ee,
    verifier: 0x34d399,
    researcher: 0xfbbf24,
    debugger: 0xf87171,
    planner: 0x60a5fa,
  };
  return palette[roleId] ?? 0x93c5fd;
}

function layoutNodes(agents: HierarchyAgent[]): Map<string, THREE.Vector3> {
  const positions = new Map<string, THREE.Vector3>();
  const roots = agents.filter((a) => !a.parentId);
  const childrenOf = (id: string) => agents.filter((a) => a.parentId === id);

  const place = (agent: HierarchyAgent, depth: number, index: number, siblings: number) => {
    const angle = siblings <= 1 ? 0 : (index / Math.max(1, siblings - 1) - 0.5) * Math.PI * 0.9;
    const radius = 1.2 + depth * 1.35;
    const y = (depth - 1) * -0.9;
    positions.set(
      agent.id,
      new THREE.Vector3(Math.sin(angle) * radius, y, Math.cos(angle) * radius),
    );
    const kids = childrenOf(agent.id);
    kids.forEach((child, i) => place(child, depth + 1, i, kids.length));
  };

  roots.forEach((root, i) => place(root, 0, i, roots.length));

  for (const agent of agents) {
    if (!positions.has(agent.id)) {
      positions.set(agent.id, new THREE.Vector3((Math.random() - 0.5) * 4, 0, (Math.random() - 0.5) * 4));
    }
  }
  return positions;
}

export default function SwarmTopologyVisualizer({
  agents,
  connected = false,
  className = '',
  onSelectAgent,
}: SwarmTopologyVisualizerProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const agentsRef = useRef(agents);
  const rebuildRef = useRef<(() => void) | null>(null);
  agentsRef.current = agents;

  const syncKey = agents.map((a) => `${a.id}:${a.activity}:${a.status}`).join('|');

  useEffect(() => {
    rebuildRef.current?.();
  }, [syncKey]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x040414, 0.08);

    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(0, 2.5, 6.5);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x040414, 1);
    mount.appendChild(renderer.domElement);

    const ambient = new THREE.AmbientLight(0xffffff, 0.35);
    const key = new THREE.DirectionalLight(0x67e8f9, 0.9);
    key.position.set(4, 8, 6);
    scene.add(ambient, key);

    const nodeMeshes = new Map<string, THREE.Mesh>();
    const edgeLines: THREE.Line[] = [];
    const group = new THREE.Group();
    scene.add(group);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    const onPointer = (e: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects([...nodeMeshes.values()]);
      if (hits[0]) {
        const id = hits[0].object.userData.id as string;
        onSelectAgent?.(id);
      }
    };
    renderer.domElement.addEventListener('pointerdown', onPointer);

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

    let frame = 0;
    let raf = 0;
    const animate = () => {
      frame++;
      group.rotation.y = Math.sin(frame * 0.003) * 0.15;
      for (const mesh of nodeMeshes.values()) {
        const pulse = mesh.userData.pulse as number;
        const scale = 1 + Math.sin(frame * 0.05 + pulse) * 0.08;
        mesh.scale.setScalar(scale);
      }
      camera.lookAt(0, -0.2, 0);
      renderer.render(scene, camera);
      raf = requestAnimationFrame(animate);
    };
    animate();

    const rebuild = () => {
      for (const mesh of nodeMeshes.values()) group.remove(mesh);
      for (const line of edgeLines) group.remove(line);
      nodeMeshes.clear();
      edgeLines.length = 0;

      const list = agentsRef.current;
      const positions = layoutNodes(list);

      for (const agent of list) {
        const color = agent.live ? ACTIVITY_COLOR[agent.activity] : roleHue(agent.roleId);
        const geo = new THREE.SphereGeometry(agent.parentId ? 0.14 : 0.2, 20, 20);
        const mat = new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: agent.activity === 'idle' ? 0.15 : 0.55,
          metalness: 0.2,
          roughness: 0.45,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.copy(positions.get(agent.id)!);
        mesh.userData = { id: agent.id, pulse: Math.random() * Math.PI * 2 };
        group.add(mesh);
        nodeMeshes.set(agent.id, mesh);
      }

      for (const agent of list) {
        if (!agent.parentId) continue;
        const a = positions.get(agent.id);
        const b = positions.get(agent.parentId);
        if (!a || !b) continue;
        const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
        const mat = new THREE.LineBasicMaterial({
          color: agent.activity === 'communicating' ? 0x22d3ee : 0x334155,
          transparent: true,
          opacity: agent.activity === 'communicating' ? 0.9 : 0.45,
        });
        const line = new THREE.Line(geo, mat);
        group.add(line);
        edgeLines.push(line);
      }
    };

    rebuild();
    rebuildRef.current = rebuild;
    const syncId = window.setInterval(rebuild, 800);

    return () => {
      rebuildRef.current = null;
      window.clearInterval(syncId);
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointer);
      mount.removeChild(renderer.domElement);
      renderer.dispose();
    };
  }, [onSelectAgent]);

  return (
    <div className={`relative w-full h-full min-h-[420px] ${className}`}>
      <div ref={mountRef} className="absolute inset-0" />
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: 'radial-gradient(circle at 50% 30%, rgba(34,211,238,0.08) 0%, transparent 55%)',
        }}
      />
      <div
        className="absolute top-3 left-3 z-10 rounded-lg border border-white/10 px-3 py-2 text-[10px] font-mono text-zinc-300"
        style={{ background: 'rgba(6,6,26,0.72)', backdropFilter: 'blur(12px)' }}
      >
        <div className="text-cyan-300/90 font-semibold tracking-wide">WebGL Topology</div>
        <div className="text-zinc-500 mt-0.5">
          {agents.length} nodes · {connected ? 'SSE live' : 'offline'}
        </div>
      </div>
    </div>
  );
}
