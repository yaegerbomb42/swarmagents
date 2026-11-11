'use client';

import React, { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import { Physics, RigidBody, RapierRigidBody, interactionGroups, CuboidCollider } from '@react-three/rapier';
import { OrbitControls, Environment, ContactShadows, Text } from '@react-three/drei';
import * as THREE from 'three';
import { Agent, AgentOps } from './Agent';
import { ReflexBrain, HamiltonianBrain, RandomBrain, type AgentBrain, type Interactable } from './AgentBrain';
import { world, useWorld } from './worldStore';
import { ROOM, TICK } from './physics';
import { useModelConfig, type ModelConfig, type ProviderId } from '@/lib/modelStore';

import {
  ConferenceTable,
  WindowWall,
  WallArt,
  Shelf,
  LargeScreen,
  OfficeChair,
  Cup,
  Ball,
  CeilingPipe,
  PendantLight,
  FiddleLeafPlant,
  SmallPlant,
  ColorCube,
  ColorSphere,
  ColorPyramid,
} from './ArenaProps';

// ════════════════════════════════════════════════════════════
//  PER-AGENT BRAIN REGISTRY
//  Each agent can have its own LLM — live A/B testing in 3D
// ════════════════════════════════════════════════════════════

export interface AgentBrainConfig {
  agentId: string;
  providerId: ProviderId;
  label: string;
  endpoint: string;
  model: string;
  apiKey: string;
}

const agentBrainStore = {
  configs: new Map<string, AgentBrainConfig>(),
  listeners: new Set<() => void>(),
  get(agentId: string): AgentBrainConfig | undefined {
    return this.configs.get(agentId);
  },
  set(agentId: string, patch: Partial<AgentBrainConfig>) {
    const existing = this.configs.get(agentId);
    const next: AgentBrainConfig = {
      ...(existing || { agentId, providerId: 'ollama-local', label: 'Default', endpoint: '', model: '', apiKey: '' }),
      ...patch,
      agentId,
    };
    this.configs.set(agentId, next);
    this.emit();
  },
  emit() { this.listeners.forEach(l => l()); },
  subscribe(l: () => void) { this.listeners.add(l); return () => this.listeners.delete(l); },
};

export function useAgentBrainConfig(agentId: string): AgentBrainConfig {
  const [cfg, setCfg] = useState<AgentBrainConfig>(() =>
    agentBrainStore.get(agentId) || { agentId, providerId: 'ollama-local', label: 'Default', endpoint: '', model: '', apiKey: '' }
  );
  useEffect(() => {
    const update = () => {
      const c = agentBrainStore.get(agentId);
      if (c) setCfg(c);
    };
    update();
    return agentBrainStore.subscribe(update);
  }, [agentId]);
  return cfg;
}

export function setAgentBrainConfig(agentId: string, patch: Partial<AgentBrainConfig>) {
  agentBrainStore.set(agentId, patch);
}

export { agentBrainStore };

// ─── Brain factory ───────────────────────────────────────────
function createBrain(cfg: ModelConfig): AgentBrain {
  if (!cfg.endpoint || !cfg.model) return new ReflexBrain();
  return new HamiltonianBrain({ endpoint: cfg.endpoint, model: cfg.model, apiKey: cfg.apiKey });
}

function useBrainForAgent(agentId: string, globalCfg: ModelConfig): AgentBrain {
  const agentCfg = useAgentBrainConfig(agentId);
  return useMemo(() => {
    if (agentCfg.endpoint && agentCfg.model) {
      return createBrain({
        providerId: agentCfg.providerId,
        label: agentCfg.label,
        endpoint: agentCfg.endpoint,
        model: agentCfg.model,
        apiKey: agentCfg.apiKey,
        loraAdapter: '',
        systemPrompt: '',
      });
    }
    return createBrain(globalCfg);
  }, [agentCfg, globalCfg]);
}

// ─── AGENT DEFINITIONS ───────────────────────────────────────
interface AgentDef {
  id: string;
  label: string;
  color: string;
  start: [number, number, number];
  chairPos: [number, number, number];
  chairColor: string;
}

const AGENTS: AgentDef[] = [
  { id: 'office_a', label: 'Cy-Blue',   color: '#3b82f6', start: [-1.2, 0.7, -0.5], chairPos: [-1.8, 0, -0.5], chairColor: '#3b82f6' },
  { id: 'office_b', label: 'Cy-Green',  color: '#22c55e', start: [-1.2, 0.7,  0.5], chairPos: [-1.8, 0,  0.5], chairColor: '#22c55e' },
  { id: 'office_c', label: 'Cy-Orange', color: '#f97316', start: [ 1.2, 0.7, -0.5], chairPos: [ 1.8, 0, -0.5], chairColor: '#f97316' },
  { id: 'office_d', label: 'Cy-Yellow', color: '#eab308', start: [ 1.2, 0.7,  0.5], chairPos: [ 1.8, 0,  0.5], chairColor: '#eab308' },
  { id: 'office_e', label: 'Cy-Purple', color: '#a855f7', start: [ 0,   0.7, -1.2], chairPos: [ 0,   0, -1.8], chairColor: '#a855f7' },
  { id: 'office_f', label: 'Cy-Red',    color: '#ef4444', start: [ 0,   0.7,  1.2], chairPos: [ 0,   0,  1.8], chairColor: '#ef4444' },
  { id: 'office_g', label: 'Cy-Pink',   color: '#ec4899', start: [-0.6, 0.7,  0],   chairPos: [-1.0, 0,  0],   chairColor: '#ec4899' },
  { id: 'office_h', label: 'Cy-Cyan',   color: '#06b6d4', start: [ 0.6, 0.7,  0],   chairPos: [ 1.0, 0,  0],   chairColor: '#06b6d4' },
];

// ─── OFFICE SCENE — Aether Dynamics Conference Room ──────────
export function OfficeScene() {
  const globalCfg = useModelConfig();
  const [engineAgentData, setEngineAgentData] = useState<Array<any>>([]);
  const bodies = useRef<Record<string, RapierRigidBody | null>>({});
  const interactablesRef = useRef<Map<string, Interactable>>(new Map());

  useEffect(() => {
    const m = interactablesRef.current;
    m.set('table_center', { id: 'table_center', kind: 'table', position: { x: 0, y: 0.74, z: 0 }, novelty: 0.4 });
    m.set('screen_back',  { id: 'screen_back',  kind: 'tv',    position: { x: 0, y: 1.6, z: -ROOM.depth/2 + 0.1 }, novelty: 0.85 });
    m.set('cup_a',        { id: 'cup_a',        kind: 'cup',   position: { x: -0.8, y: 0.78, z: -0.3 }, novelty: 0.6 });
    m.set('cup_b',        { id: 'cup_b',        kind: 'cup',   position: { x:  0.8, y: 0.78, z:  0.3 }, novelty: 0.6 });
    m.set('ball_o1',      { id: 'ball_o1',      kind: 'ball',  position: { x: 0, y: 0.3, z: 0 }, novelty: 0.95 });
    AGENTS.forEach((a, i) => {
      m.set(`chair_${i}`, { id: `chair_${i}`, kind: 'couch', position: { x: a.chairPos[0], y: 0.46, z: a.chairPos[2] }, novelty: 0.5 });
    });
    m.set('plant_big',   { id: 'plant_big',   kind: 'plant', position: { x: 3.2, y: 0.5, z: -1.5 }, novelty: 0.7 });
    m.set('plant_small', { id: 'plant_small', kind: 'plant', position: { x: -3.2, y: 0.3, z: 1.5 }, novelty: 0.7 });
    m.set('wall_back',   { id: 'wall_back',   kind: 'glass_wall', position: { x: 0, y: ROOM.height/2, z: -ROOM.depth/2 }, novelty: 0.1 });
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

  const grabConstraints = useRef<Record<string, { agentId: string; objectId: string }>>({});
  const heldObjects = useRef<Record<string, string>>({});

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
    sitOn: (agentId, chairId) => {
      const ag = bodies.current[agentId];
      const chair = interactablesRef.current.get(chairId);
      if (!ag || !chair) return false;
      ag.setTranslation({ x: chair.position.x, y: chair.position.y + 0.6, z: chair.position.z }, true);
      ag.setLinvel({ x: 0, y: 0, z: 0 }, true);
      return true;
    },
  }), []);

  const heldUpdate = useCallback(() => {
    for (const [objectId, agentId] of Object.entries(heldObjects.current)) {
      const ag = bodies.current[agentId];
      const obj = bodies.current[objectId];
      if (!ag || !obj) continue;
      const ap = ag.translation();
      obj.setTranslation({ x: ap.x, y: ap.y + 1.0, z: ap.z + 0.5 }, true);
      obj.setLinvel({ x: 0, y: 0, z: 0 }, true);
      obj.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }, []);

  return (
    <>
      <Physics gravity={[0, -9.81, 0]} timeStep="vary">
        <SceneLighting />

        {/* Floor — warm wood */}
        <RigidBody type="fixed" collisionGroups={interactionGroups(1, 0xFFFF)}>
          <mesh receiveShadow rotation={[-Math.PI/2, 0, 0]} position={[0, 0, 0]}>
            <planeGeometry args={[ROOM.width * 4, ROOM.depth * 4]} />
            <meshStandardMaterial color="#d4a76a" roughness={0.55} metalness={0.02} />
          </mesh>
          <CuboidCollider args={[ROOM.width * 2, 0.05, ROOM.depth * 2]} position={[0, -0.05, 0]} />
        </RigidBody>

        {/* Window wall — left side, natural light */}
        <WindowWall position={[-ROOM.width/2, ROOM.height/2, 0]} />

        {/* Back wall (solid, holds the screen) */}
        <RigidBody type="fixed" collisionGroups={interactionGroups(2, 0xFFFF)}>
          <mesh position={[0, ROOM.height/2, -ROOM.depth/2]}>
            <boxGeometry args={[ROOM.width, ROOM.height, 0.05]} />
            <meshStandardMaterial color="#f5f5f5" roughness={0.9} />
          </mesh>
        </RigidBody>

        {/* Front wall (solid) */}
        <RigidBody type="fixed" collisionGroups={interactionGroups(2, 0xFFFF)}>
          <mesh position={[0, ROOM.height/2, ROOM.depth/2]}>
            <boxGeometry args={[ROOM.width, ROOM.height, 0.05]} />
            <meshStandardMaterial color="#f5f5f5" roughness={0.9} />
          </mesh>
        </RigidBody>

        {/* Right wall (solid) */}
        <RigidBody type="fixed" collisionGroups={interactionGroups(2, 0xFFFF)}>
          <mesh position={[ROOM.width/2, ROOM.height/2, 0]}>
            <boxGeometry args={[0.05, ROOM.height, ROOM.depth]} />
            <meshStandardMaterial color="#f5f5f5" roughness={0.9} />
          </mesh>
        </RigidBody>

        {/* ─── Center Conference Table ─── */}
        <ConferenceTable position={[0, 0, 0]} />

        {/* Geometric toys on table */}
        <ColorCube position={[-0.6, 0.79, -0.3]} color="#3b82f6" size={0.22} />
        <ColorCube position={[0.5, 0.79, 0.2]} color="#ef4444" size={0.18} />
        <ColorSphere position={[0, 0.85, 0]} color="#f97316" radius={0.15} />
        <ColorPyramid position={[-0.2, 0.82, 0.35]} color="#22c55e" size={0.2} />
        <ColorSphere position={[0.7, 0.82, -0.4]} color="#eab308" radius={0.12} />
        <ColorCube position={[-0.4, 0.79, 0.5]} color="#a855f7" size={0.16} />

        {/* Cups */}
        <Cup position={[-0.8, 0.85, -0.3]} id="cup_a" />
        <Cup position={[ 0.8, 0.85,  0.3]} id="cup_b" />

        {/* Stress ball */}
        <Ball position={[0, 0.5, 1.5]} id="ball_o1" color="#f97316" />

        {/* ─── Colorful Chairs around table ─── */}
        {AGENTS.map((a, i) => (
          <OfficeChair key={a.id} position={a.chairPos} color={a.chairColor} />
        ))}

        {/* ─── Aether Dynamics Screen ─── */}
        <LargeScreen position={[0, 1.6, -ROOM.depth/2 + 0.06]} />

        {/* ─── Wall Art — geometric decorations ─── */}
        <WallArt
          position={[-3.5, 1.4, -ROOM.depth/2 + 0.06]}
          shapes={[
            { type: 'triangle', color: '#ef4444', size: 0.3, offset: [-0.5, 0.2] },
            { type: 'circle',   color: '#3b82f6', size: 0.2, offset: [0.3, 0.3] },
            { type: 'triangle', color: '#22c55e', size: 0.25, offset: [0.1, -0.3] },
            { type: 'circle',   color: '#f97316', size: 0.15, offset: [-0.3, -0.2] },
          ]}
        />
        <WallArt
          position={[3.5, 1.4, -ROOM.depth/2 + 0.06]}
          shapes={[
            { type: 'triangle', color: '#a855f7', size: 0.28, offset: [0.2, 0.1] },
            { type: 'circle',   color: '#eab308', size: 0.22, offset: [-0.4, 0.3] },
            { type: 'triangle', color: '#ec4899', size: 0.2, offset: [0, -0.35] },
            { type: 'circle',   color: '#06b6d4', size: 0.18, offset: [0.4, -0.1] },
          ]}
        />

        {/* ─── Floating Shelves with Toys ─── */}
        <Shelf
          position={[-3.8, 1.8, -ROOM.depth/2 + 0.2]}
          items={[
            { type: 'cube', color: '#ef4444', size: 0.18 },
            { type: 'sphere', color: '#3b82f6', size: 0.2 },
            { type: 'cone', color: '#22c55e', size: 0.16 },
            { type: 'pyramid', color: '#f97316', size: 0.18 },
          ]}
        />
        <Shelf
          position={[3.8, 1.8, -ROOM.depth/2 + 0.2]}
          items={[
            { type: 'sphere', color: '#a855f7', size: 0.2 },
            { type: 'cube', color: '#eab308', size: 0.18 },
            { type: 'pyramid', color: '#ec4899', size: 0.16 },
            { type: 'cone', color: '#06b6d4', size: 0.18 },
          ]}
        />

        {/* ─── Plants ─── */}
        <FiddleLeafPlant position={[3.8, 0, -1.5]} />
        <SmallPlant position={[-3.8, 0, 1.5]} />

        {/* ─── Eight Humanoid Agents — each with their own brain ─── */}
        {AGENTS.map((a) => (
          <AgentWithBrain
            key={a.id}
            def={a}
            globalCfg={globalCfg}
            ops={ops}
            getInteractables={() => Array.from(interactablesRef.current.values())}
          />
        ))}

        <HeldUpdater fn={heldUpdate} />
      </Physics>

      {/* Rainbow ceiling pipes */}
      <CeilingPipe from={[-ROOM.width/2, ROOM.height - 0.05, -2.0]} to={[ROOM.width/2, ROOM.height - 0.05, -2.0]} color="#ef4444" />
      <CeilingPipe from={[-ROOM.width/2, ROOM.height - 0.05, -1.0]} to={[ROOM.width/2, ROOM.height - 0.05, -1.0]} color="#f97316" />
      <CeilingPipe from={[-ROOM.width/2, ROOM.height - 0.05,  0.0]} to={[ROOM.width/2, ROOM.height - 0.05,  0.0]} color="#eab308" />
      <CeilingPipe from={[-ROOM.width/2, ROOM.height - 0.05,  1.0]} to={[ROOM.width/2, ROOM.height - 0.05,  1.0]} color="#22c55e" />
      <CeilingPipe from={[-ROOM.width/2, ROOM.height - 0.05,  2.0]} to={[ROOM.width/2, ROOM.height - 0.05,  2.0]} color="#3b82f6" />
      <CeilingPipe from={[-3.0, ROOM.height - 0.08, -ROOM.depth/2]} to={[-3.0, ROOM.height - 0.08, ROOM.depth/2]} color="#a855f7" />
      <CeilingPipe from={[ 3.0, ROOM.height - 0.08, -ROOM.depth/2]} to={[ 3.0, ROOM.height - 0.08, ROOM.depth/2]} color="#ec4899" />

      {/* Pendant lights */}
      <PendantLight position={[-2, ROOM.height - 0.3, 0]} color="#eab308" />
      <PendantLight position={[0, ROOM.height - 0.3, 0]} color="#ef4444" />
      <PendantLight position={[2, ROOM.height - 0.3, 0]} color="#3b82f6" />

      <CameraRig />
      <Environment preset="apartment" />
      <ContactShadows position={[0, 0.01, 0]} opacity={0.35} scale={20} blur={2.4} far={5} />
    </>
  );
}

// Wrapper that gives each agent its own brain instance
function AgentWithBrain({ def, globalCfg, ops, getInteractables }: {
  def: AgentDef;
  globalCfg: ModelConfig;
  ops: AgentOps;
  getInteractables: () => Interactable[];
}) {
  const brain = useBrainForAgent(def.id, globalCfg);
  return (
    <Agent
      id={def.id}
      label={def.label}
      color={def.color}
      start={def.start}
      brain={brain}
      ops={ops}
      getInteractables={getInteractables}
    />
  );
}

function SceneLighting() {
  return (
    <>
      <ambientLight intensity={1.2} color="#fffbf0" />
      <directionalLight position={[6, 10, 6]} intensity={1.4} castShadow shadow-mapSize-width={1024} shadow-mapSize-height={1024} color="#fff8e8" />
      <directionalLight position={[-6, 8, -3]} intensity={0.5} color="#f0f4ff" />
      <pointLight position={[0, 2.7, 0]} intensity={0.5} color="#fff" />
      <hemisphereLight args={['#b3d4ff', '#d4a76a', 0.5]} />
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

// re-export for use in other components
export { AGENTS };
