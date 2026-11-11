'use client';

import React, { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { Physics, RigidBody, RapierRigidBody, vec3 } from '@react-three/rapier';
import { OrbitControls, Environment, ContactShadows, Stars, Sky, Html } from '@react-three/drei';
import * as THREE from 'three';
import { Agent, AgentOps } from './Agent';
import { ReflexBrain, HamiltonianBrain, RandomBrain, type AgentBrain, type Interactable } from './AgentBrain';
import { world, useWorld } from './worldStore';
import { ROOM, GLASS_BREAK_KE_THRESHOLD, TICK } from './physics';

// Lazy-imported room+furniture from Arena.tsx to keep file sizes manageable
import { Room, Couch, Table, TV, Plant, Cup, Ball, Drone, Bookshelf, Whiteboard, NeonStrip } from './ArenaProps';

// ────────────────────────────────────────────────────────────
//  Brain provider hook (switches based on world store)
// ────────────────────────────────────────────────────────────
function useBrainProvider(): AgentBrain {
  const id = useWorld(s => s.brainProviderId);
  const ep = useWorld(s => s.hamiltonianEndpoint);
  const model = useWorld(s => s.hamiltonianModel);
  const apiKey = useWorld(s => s.hamiltonianApiKey);
  return useMemo(() => {
    if (id === 'hamiltonian') return new HamiltonianBrain({ endpoint: ep, model, apiKey });
    if (id === 'random')      return new RandomBrain();
    return new ReflexBrain();
  }, [id, ep, model, apiKey]);
}

// ────────────────────────────────────────────────────────────
//  Scene
// ────────────────────────────────────────────────────────────
export function ArenaScene() {
  const brain = useBrainProvider();
  const [engineAgentData, setEngineAgentData] = useState<Array<any>>([]);
  const bodies = useRef<Record<string, RapierRigidBody | null>>({});

  // Interactibles registry (gets populated by props when they mount and ticks update from physics)
  const interactablesRef = useRef<Map<string, Interactable>>(new Map());

  // Static interactibles (don't move much)
  useEffect(() => {
    const m = interactablesRef.current;
    m.set('tv1',     { id: 'tv1',     kind: 'tv',     position: { x: 0, y: 1.6, z: -ROOM.depth/2 + 0.1 }, novelty: 0.85, state: { channel: 0 } });
    m.set('couch1',  { id: 'couch1',  kind: 'couch',  position: { x: 0, y: 0.4, z: ROOM.depth/2 - 1.0 }, novelty: 0.5 });
    m.set('table1',  { id: 'table1',  kind: 'table',  position: { x: 0, y: 0.4, z: 0 }, novelty: 0.4 });
    m.set('plant1',  { id: 'plant1',  kind: 'plant',  position: { x: -ROOM.width/2 + 0.6, y: 0.3, z: -ROOM.depth/2 + 0.5 }, novelty: 0.7 });
    m.set('drone1',  { id: 'drone1',  kind: 'drone',  position: { x:  ROOM.width/2 - 0.6, y: 0.5, z: -ROOM.depth/2 + 0.5 }, novelty: 0.95 });
    m.set('cup1',    { id: 'cup1',    kind: 'cup',    position: { x: -0.4, y: 0.5, z: 0.05 }, novelty: 0.6 });
    m.set('cup2',    { id: 'cup2',    kind: 'cup',    position: { x:  0.4, y: 0.5, z: -0.05 }, novelty: 0.6 });
    m.set('ball1',   { id: 'ball1',   kind: 'ball',   position: { x: -1.5, y: 0.5, z: 1.2 }, novelty: 0.9 });
    m.set('ball2',   { id: 'ball2',   kind: 'ball',   position: { x:  1.5, y: 0.5, z: -1.2 }, novelty: 0.9 });
    m.set('wall_back',  { id: 'wall_back',  kind: 'glass_wall', position: { x: 0, y: ROOM.height/2, z: -ROOM.depth/2 }, novelty: 0.3 });
    m.set('wall_front', { id: 'wall_front', kind: 'glass_wall', position: { x: 0, y: ROOM.height/2, z:  ROOM.depth/2 }, novelty: 0.3 });
    m.set('wall_left',  { id: 'wall_left',  kind: 'glass_wall', position: { x: -ROOM.width/2, y: ROOM.height/2, z: 0 }, novelty: 0.3 });
    m.set('wall_right', { id: 'wall_right', kind: 'glass_wall', position: { x:  ROOM.width/2, y: ROOM.height/2, z: 0 }, novelty: 0.3 });
  }, []);

  // Fetch live agent data from API
  useEffect(() => {
    const fetchAgentData = async () => {
      try {
        const res = await fetch('/api/agents');
        const data = await res.json();
        if (data?.agents) {
          setEngineAgentData(data.agents);
          // Update world store with engine data for consistency
          data.agents.forEach(agent => {
            world.updateAgent(agent.id, {
              status: agent.status,
              active_tasks: agent.active_tasks,
              tasks_completed: agent.tasks_completed,
              tasks_failed: agent.tasks_failed,
              avg_response_time: agent.avg_response_time,
              success_rate: agent.success_rate,
            });
          });
        }
      } catch (error) {
        console.warn('Failed to fetch agent data:', error);
      }
    };

    fetchAgentData();
    const interval = setInterval(fetchAgentData, 5000); // Fetch every 5 seconds
    return () => clearInterval(interval);
  }, []);

  // Agent op handlers
  const grabConstraints = useRef<Record<string, { agentId: string; objectId: string }>>({}); // agentId -> { objectId }
  const heldObjects = useRef<Record<string, string>>({}); // objectId -> agentId

  const ops: AgentOps = useMemo(() => ({
    registerBody: (id, body) => { bodies.current[id] = body; },
    pickup: (agentId, objectId) => {
      const ag = bodies.current[agentId];
      const target = interactablesRef.current.get(objectId);
      if (!ag || !target) return false;
      const at = ag.translation();
      const d = Math.hypot(at.x - target.position.x, at.y - target.position.y, at.z - target.position.z);
      if (d > TICK.pickupRange + 0.3) return false;
      heldObjects.current[objectId] = agentId;
      grabConstraints.current[agentId] = { agentId, objectId };
      return true;
    },
    drop: (agentId) => {
      const link = grabConstraints.current[agentId];
      if (!link) return false;
      delete heldObjects.current[link.objectId];
      delete grabConstraints.current[agentId];
      return true;
    },
    throwAt: (agentId, targetId) => {
      const link = grabConstraints.current[agentId];
      if (!link) return false;
      const target = interactablesRef.current.get(targetId);
      const ag = bodies.current[agentId];
      const obj = bodies.current[link.objectId];
      if (!ag || !target || !obj) return false;
      const ap = ag.translation();
      const dir = new THREE.Vector3(target.position.x - ap.x, (target.position.y + 0.3) - ap.y, target.position.z - ap.z).normalize();
      obj.setLinvel({ x: dir.x * TICK.throwSpeed, y: dir.y * TICK.throwSpeed + 1.2, z: dir.z * TICK.throwSpeed }, true);
      obj.setAngvel({ x: (Math.random()-0.5)*8, y: (Math.random()-0.5)*8, z: (Math.random()-0.5)*8 }, true);
      delete heldObjects.current[link.objectId];
      delete grabConstraints.current[agentId];
      return true;
    },
    changeChannel: (tvId) => world.cycleTvChannel(tvId, 6),
    sitOn: (agentId, couchId) => {
      const ag = bodies.current[agentId];
      const couch = interactablesRef.current.get(couchId);
      if (!ag || !couch) return false;
      ag.setTranslation({ x: couch.position.x, y: couch.position.y + 0.7, z: couch.position.z }, true);
      ag.setLinvel({ x: 0, y: 0, z: 0 }, true);
      return true;
    },
  }), []);

  // Update held object positions each frame: snap object to agent's hand
  const heldUpdate = useCallback(() => {
    for (const [objectId, agentId] of Object.entries(heldObjects.current)) {
      const ag = bodies.current[agentId];
      const obj = bodies.current[objectId];
      if (!ag || !obj) continue;
      const ap = ag.translation();
      // Hand position roughly 0.4m in front + 0.85m up
      obj.setTranslation({ x: ap.x, y: ap.y + 1.0, z: ap.z + 0.5 }, true);
      obj.setLinvel({ x: 0, y: 0, z: 0 }, true);
      obj.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }, []);

  return (
    <>
      <Physics gravity={[0, -9.81, 0]} timeStep="vary">
        <SceneLighting />
        <Room />
        <Couch position={[0, 0, ROOM.depth/2 - 1.0]} />
        <Table position={[0, 0, 0]} />
        <TV position={[0, 1.6, -ROOM.depth/2 + 0.08]} channels={CHANNELS} />
        <Plant position={[-ROOM.width/2 + 0.6, 0, -ROOM.depth/2 + 0.5]} />
        <Drone position={[ ROOM.width/2 - 0.6, 0.5, -ROOM.depth/2 + 0.5]} />
        <Bookshelf position={[ROOM.width/2 - 0.2, 1.0, 0]} />
        <Whiteboard position={[-ROOM.width/2 + 0.05, 1.6, 1.0]} />
        <Cup position={[-0.4, 0.5, 0.05]} id="cup1" />
        <Cup position={[ 0.4, 0.5, -0.05]} id="cup2" />
        <Ball position={[-1.5, 0.5,  1.2]} id="ball1" color="#fda4af" />
        <Ball position={[ 1.5, 0.5, -1.2]} id="ball2" color="#fbbf24" />

        <Agent id="agent_a" label="Cy-1" color="#67e8f9" start={[-2.0, 0.7,  1.5]} brain={brain} ops={ops} getInteractables={() => Array.from(interactablesRef.current.values())} />
        <Agent id="agent_b" label="Cy-2" color="#a78bfa" start={[ 2.0, 0.7, -1.5]} brain={brain} ops={ops} getInteractables={() => Array.from(interactablesRef.current.values())} />
        <Agent id="agent_c" label="Cy-3" color="#fda4af" start={[-2.5, 0.7, -1.0]} brain={brain} ops={ops} getInteractables={() => Array.from(interactablesRef.current.values())} />
        <Agent id="agent_d" label="Cy-4" color="#86efac" start={[ 2.5, 0.7,  1.0]} brain={brain} ops={ops} getInteractables={() => Array.from(interactablesRef.current.values())} />

        <HeldUpdater fn={heldUpdate} />
        <GlassImpactWatcher />
      </Physics>

      {/* Neon accent strips along ceiling edges */}
      <NeonStrip from={[-ROOM.width/2, ROOM.height - 0.01, -ROOM.depth/2]} to={[ROOM.width/2, ROOM.height - 0.01, -ROOM.depth/2]} />
      <NeonStrip from={[-ROOM.width/2, ROOM.height - 0.01, ROOM.depth/2]}  to={[ROOM.width/2, ROOM.height - 0.01, ROOM.depth/2]} />
      <NeonStrip from={[-ROOM.width/2, ROOM.height - 0.01, -ROOM.depth/2]} to={[-ROOM.width/2, ROOM.height - 0.01, ROOM.depth/2]} color="#67e8f9" />
      <NeonStrip from={[ROOM.width/2, ROOM.height - 0.01, -ROOM.depth/2]}  to={[ROOM.width/2, ROOM.height - 0.01, ROOM.depth/2]} color="#67e8f9" />

      <CameraRig />
      <Environment preset="city" />
      <ContactShadows position={[0, 0.01, 0]} opacity={0.55} scale={20} blur={2.4} far={5} />
      <Stars radius={50} depth={60} count={2000} factor={3} fade speed={0.4} />
      <CityScape />
    </>
  );
}

/** Procedural city skyline visible outside the glass walls. */
function CityScape() {
  const buildings = useMemo(() => {
    const out: { x: number; z: number; w: number; h: number; d: number; color: string }[] = [];
    const ringDist = 22;
    // place a ring of buildings around the room
    for (let i = 0; i < 60; i++) {
      const angle = (i / 60) * Math.PI * 2 + (Math.random() - 0.5) * 0.2;
      const r = ringDist + Math.random() * 8;
      const x = Math.cos(angle) * r;
      const z = Math.sin(angle) * r;
      const w = 1.5 + Math.random() * 2.5;
      const h = 4 + Math.random() * 16;
      const d = 1.5 + Math.random() * 2.5;
      const hue = 200 + Math.random() * 80;
      const sat = 30 + Math.random() * 40;
      const light = 8 + Math.random() * 18;
      out.push({ x, z, w, h, d, color: `hsl(${hue}, ${sat}%, ${light}%)` });
    }
    return out;
  }, []);

  const windowLights = useMemo(() => {
    const lights: { x: number; y: number; z: number }[] = [];
    for (const b of buildings) {
      const ny = Math.max(3, Math.floor(b.h / 0.8));
      const nx = Math.max(2, Math.floor(b.w / 0.5));
      for (let i = 0; i < ny; i++) {
        for (let j = 0; j < nx; j++) {
          if (Math.random() > 0.4) {
            lights.push({
              x: b.x + (j / (nx - 1) - 0.5) * b.w * 0.85,
              y: 0.5 + (i / (ny - 1)) * b.h * 0.85,
              z: b.z + (b.d / 2 + 0.001) * Math.sign(b.z),
            });
          }
        }
      }
    }
    return lights;
  }, [buildings]);

  return (
    <group>
      {buildings.map((b, i) => (
        <mesh key={i} position={[b.x, b.h / 2, b.z]}>
          <boxGeometry args={[b.w, b.h, b.d]} />
          <meshStandardMaterial color={b.color} roughness={0.8} metalness={0.4} />
        </mesh>
      ))}
      {/* Emissive window points (instanced for perf would be better, but this is fine for ~600 pts) */}
      {windowLights.slice(0, 600).map((l, i) => (
        <mesh key={i} position={[l.x, l.y, l.z]}>
          <boxGeometry args={[0.05, 0.05, 0.05]} />
          <meshBasicMaterial color={Math.random() > 0.85 ? '#fde68a' : '#67e8f9'} />
        </mesh>
      ))}
      {/* Ground plane outside the room */}
      <mesh position={[0, -0.02, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[200, 200]} />
        <meshStandardMaterial color="#0a0a18" roughness={0.95} />
      </mesh>
    </group>
  );
}

function SceneLighting() {
  return (
    <>
      <ambientLight intensity={0.55} color="#a5f3fc" />
      <directionalLight position={[6, 8, 6]} intensity={1.2} castShadow shadow-mapSize-width={1024} shadow-mapSize-height={1024} color="#ffffff" />
      <directionalLight position={[-6, 5, -3]} intensity={0.35} color="#67e8f9" />
      <pointLight position={[0, 2.7, 0]} intensity={0.6} color="#5eead4" />
    </>
  );
}

function CameraRig() {
  const { camera } = useThree();
  const cameraMode = useWorld(s => s.cameraMode);
  const selectedId = useWorld(s => s.selectedAgentId);
  const agentPos = useWorld(s => selectedId ? s.agents[selectedId]?.position : null);

  useFrame((_, dt) => {
    if (!agentPos) return;
    if (cameraMode === 'pov') {
      const target = new THREE.Vector3(agentPos.x, agentPos.y + 1.55, agentPos.z + 0.15);
      camera.position.lerp(target, Math.min(1, dt * 6));
      camera.lookAt(agentPos.x, agentPos.y + 1.55, agentPos.z + 1);
    } else if (cameraMode === 'over-shoulder') {
      const target = new THREE.Vector3(agentPos.x - 1.4, agentPos.y + 2.0, agentPos.z + 1.4);
      camera.position.lerp(target, Math.min(1, dt * 4));
      camera.lookAt(agentPos.x, agentPos.y + 1.0, agentPos.z);
    } else if (cameraMode === 'cinematic') {
      const t = performance.now() * 0.0002;
      camera.position.set(Math.sin(t) * 8, 3.2, Math.cos(t) * 8);
      camera.lookAt(0, 1.0, 0);
    }
  });

  if (cameraMode === 'orbit') return <OrbitControls enableDamping makeDefault target={[0, 1, 0]} maxDistance={20} minDistance={3} />;
  return null;
}

function HeldUpdater({ fn }: { fn: () => void }) {
  useFrame(() => fn());
  return null;
}

// Watch for fast collisions on glass walls; break them if KE exceeds threshold
function GlassImpactWatcher() {
  // We rely on body userData to identify walls. Listen at world level.
  // For simplicity, monitor each frame's collision events via Physics's onContactForceEvent.
  // In rapier-react, we just expose a callback on individual RigidBody components.
  // (Hooks are added on the Wall component in Arena.tsx; this is here as a placeholder if global needed.)
  return null;
}

const CHANNELS = [
  { color: '#020617', label: 'NEWS' },
  { color: '#5eead4', label: 'NATURE' },
  { color: '#a78bfa', label: 'STATIC' },
  { color: '#fda4af', label: 'CARTOON' },
  { color: '#fbbf24', label: 'SPORTS' },
  { color: '#0ea5e9', label: 'COSMOS' },
];

export { CHANNELS };
