'use client';

import React, { useRef, useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { RigidBody, RapierRigidBody, CapsuleCollider, BallCollider, vec3 } from '@react-three/rapier';
import { Html, Text } from '@react-three/drei';
import * as THREE from 'three';
import { MATERIALS, TICK } from './physics';
import { world, useWorld } from './worldStore';
import type { AgentBrain, AgentPerception, AgentAction, Interactable } from './AgentBrain';
import { dist } from './AgentBrain';

interface AgentProps {
  id: string;
  label: string;
  color: string;
  start: [number, number, number];
  brain: AgentBrain;
  /** Provided by Arena to perform actions on world (pickup, throw, channel) */
  ops: AgentOps;
  /** Snapshot of all interactibles in the room */
  getInteractables: () => Interactable[];
}

export interface AgentOps {
  pickup: (agentId: string, interactableId: string) => boolean;
  drop:   (agentId: string) => boolean;
  throwAt: (agentId: string, targetId: string) => boolean;
  changeChannel: (tvId: string) => void;
  sitOn: (agentId: string, couchId: string) => boolean;
  /** Called by Arena to register an Agent's rigid body ref */
  registerBody: (id: string, body: RapierRigidBody | null) => void;
}

const FACE_OFFSET_Y = 0.85;          // capsule height/2 + head offset

export function Agent({ id, label, color, start, brain, ops, getInteractables }: AgentProps) {
  const bodyRef = useRef<RapierRigidBody>(null);
  const meshGroupRef = useRef<THREE.Group>(null);
  const legL = useRef<THREE.Mesh>(null);
  const legR = useRef<THREE.Mesh>(null);
  const armL = useRef<THREE.Mesh>(null);
  const armR = useRef<THREE.Mesh>(null);
  const gaitT = useRef(0);

  // Decision loop
  const lastDecisionAt = useRef(0);
  const currentTarget = useRef<{ id: string; pos: THREE.Vector3 } | null>(null);
  const currentAction = useRef<AgentAction | null>(null);
  const momentum = useRef<string[]>([]);
  const energy = useRef(1.0);
  const mood = useRef<AgentPerception['S_t']['mood']>('curious');
  const moving = useRef(false);
  const tick = useRef(0);

  useEffect(() => {
    world.registerAgent({
      id, label, color,
      mood: mood.current,
      energy: energy.current,
      position: { x: start[0], y: start[1], z: start[2] },
      holding: null,
    });
    return () => { ops.registerBody(id, null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Procedural walking + brain tick
  useFrame((_, dt) => {
    const body = bodyRef.current;
    if (!body) return;
    const t = world.get().timeScale;
    if (t === 0) return;
    const scaledDt = dt * t;

    const tr = body.translation();
    const pos = new THREE.Vector3(tr.x, tr.y, tr.z);

    // Sync world store position (throttled)
    if (Math.random() < 0.15) {
      world.updateAgent(id, {
        position: { x: pos.x, y: pos.y, z: pos.z },
        energy: energy.current,
        mood: mood.current,
      });
    }

    // Brain tick
    const now = performance.now();
    const desiredIntervalMs = 1000 / TICK.brainHz / t;
    if (now - lastDecisionAt.current > desiredIntervalMs) {
      lastDecisionAt.current = now;
      tick.current += 1;
      const perception = buildPerception(id, label, pos, mood.current, energy.current, momentum.current, getInteractables(), tick.current);
      brain.decide(perception).then(action => {
        currentAction.current = action;
        applyAction(action, perception);
        momentum.current = [...momentum.current.slice(-5), describeMomentum(action)];
        world.recordThought({ agentId: id, agentLabel: label, perception, action });
        if (action.rationale) world.setSpeech(id, action.rationale);
      });
    }

    // Drive toward target if walking
    if (currentTarget.current) {
      const target = currentTarget.current.pos;
      const flatTarget = new THREE.Vector3(target.x, pos.y, target.z);
      const dir = flatTarget.clone().sub(pos);
      const dst = dir.length();
      if (dst < 0.4) {
        moving.current = false;
        currentTarget.current = null;
        // zero out velocity
        body.setLinvel({ x: 0, y: body.linvel().y, z: 0 }, true);
      } else {
        dir.normalize();
        // Smoothly accelerate toward target
        const cur = body.linvel();
        const desiredVel = dir.clone().multiplyScalar(TICK.maxSpeed);
        const vel = {
          x: lerp(cur.x, desiredVel.x, Math.min(1, scaledDt * TICK.acceleration / TICK.maxSpeed)),
          y: cur.y,
          z: lerp(cur.z, desiredVel.z, Math.min(1, scaledDt * TICK.acceleration / TICK.maxSpeed)),
        };
        body.setLinvel(vel, true);
        // Face direction of travel
        if (meshGroupRef.current) {
          const yaw = Math.atan2(dir.x, dir.z);
          const cur = meshGroupRef.current.rotation.y;
          const delta = wrapAngle(yaw - cur);
          meshGroupRef.current.rotation.y += delta * Math.min(1, scaledDt * TICK.turnRate);
        }
        moving.current = true;
      }
    } else {
      // Friction stop
      moving.current = false;
      const cur = body.linvel();
      body.setLinvel({ x: cur.x * 0.85, y: cur.y, z: cur.z * 0.85 }, true);
    }

    // Energy regen / drain — seated agents recover 3x faster
    const seated = currentAction.current?.type === 'sit_on' || currentAction.current?.type === 'idle';
    if (moving.current) energy.current = Math.max(0, energy.current - scaledDt * 0.02);
    else                energy.current = Math.min(1, energy.current + scaledDt * (seated ? 0.12 : 0.04));

    // Gait animation
    gaitT.current += scaledDt * (moving.current ? 6 : 0);
    const swing = Math.sin(gaitT.current) * 0.35;
    if (legL.current) legL.current.rotation.x =  swing;
    if (legR.current) legR.current.rotation.x = -swing;
    if (armL.current) armL.current.rotation.x = -swing * 0.7;
    if (armR.current) armR.current.rotation.x =  swing * 0.7;
  });

  function applyAction(action: AgentAction, perception: AgentPerception) {
    switch (action.type) {
      case 'walk_to': {
        const t = perception.visible.find(v => v.id === action.target_id);
        if (t) currentTarget.current = { id: t.id, pos: new THREE.Vector3(t.position.x, t.position.y, t.position.z) };
        mood.current = 'curious';
        break;
      }
      case 'pickup': {
        if (action.target_id) {
          const ok = ops.pickup(id, action.target_id);
          if (ok) {
            world.updateAgent(id, { holding: action.target_id });
            mood.current = 'amused';
          }
        }
        currentTarget.current = null;
        break;
      }
      case 'drop': {
        ops.drop(id);
        world.updateAgent(id, { holding: null });
        currentTarget.current = null;
        break;
      }
      case 'throw': {
        if (action.target_id) {
          ops.throwAt(id, action.target_id);
          world.updateAgent(id, { holding: null });
          mood.current = 'agitated';
        }
        currentTarget.current = null;
        break;
      }
      case 'change_channel': {
        if (action.target_id) ops.changeChannel(action.target_id);
        mood.current = 'amused';
        currentTarget.current = null;
        break;
      }
      case 'sit_on': {
        if (action.target_id) ops.sitOn(id, action.target_id);
        mood.current = 'focused';
        currentTarget.current = null;
        break;
      }
      case 'stand_up': {
        // Simply release from seated state — let physics handle gravity.
        if (bodyRef.current) {
          const pos = bodyRef.current.translation();
          bodyRef.current.setTranslation({ x: pos.x, y: pos.y + 0.2, z: pos.z + 0.6 }, true);
          bodyRef.current.setLinvel({ x: 0, y: 0.5, z: 0.8 }, true);
        }
        mood.current = 'curious';
        currentTarget.current = null;
        break;
      }
      case 'punch_glass': {
        // Apply an impulse to the nearest glass wall by tossing the body into it.
        if (action.target_id) {
          const wall = perception.visible.find(v => v.id === action.target_id);
          if (wall && bodyRef.current) {
            const pos = bodyRef.current.translation();
            const dir = new THREE.Vector3(wall.position.x - pos.x, 0, wall.position.z - pos.z).normalize();
            bodyRef.current.applyImpulse({ x: dir.x * 50, y: 5, z: dir.z * 50 }, true);
          }
          mood.current = 'agitated';
        }
        break;
      }
      case 'try_escape': {
        // Pick the nearest broken-wall direction and walk through it.
        const brokens = perception.visible.filter(v => v.kind === 'glass_wall' && v.notes?.includes('broken'));
        if (brokens.length) {
          const w = brokens[0];
          // Aim 3m beyond the wall.
          const pos = bodyRef.current?.translation();
          if (pos) {
            const dx = w.position.x - pos.x;
            const dz = w.position.z - pos.z;
            const len = Math.hypot(dx, dz) || 1;
            currentTarget.current = {
              id: w.id,
              pos: new THREE.Vector3(w.position.x + (dx / len) * 3, 0.7, w.position.z + (dz / len) * 3),
            };
          }
          mood.current = 'curious';
        }
        break;
      }
      case 'speak': {
        // Speech is already shown via lastSpeech; nothing else to do here.
        mood.current = 'amused';
        currentTarget.current = null;
        break;
      }
      case 'observe':
      case 'idle':
      default:
        currentTarget.current = null;
    }
  }

  // Setup: link body to ops
  return (
    <RigidBody
      ref={(r) => { bodyRef.current = r as RapierRigidBody | null; ops.registerBody(id, r as RapierRigidBody | null); }}
      type="dynamic"
      position={start}
      colliders={false}
      enabledRotations={[false, true, false]}     // only yaw rotates
      lockRotations={false}
      linearDamping={MATERIALS.agent_body.linearDamping}
      angularDamping={MATERIALS.agent_body.angularDamping}
      friction={MATERIALS.agent_body.friction}
      restitution={MATERIALS.agent_body.restitution}
      userData={{ kind: 'agent', id }}
      ccd
    >
      <CapsuleCollider args={[0.4, 0.25]} position={[0, 0.65, 0]} />
      <BallCollider args={[0.18]} position={[0, FACE_OFFSET_Y + 0.35, 0]} />

      <group ref={meshGroupRef}>
        {/* Body */}
        <mesh position={[0, 0.65, 0]} castShadow>
          <capsuleGeometry args={[0.25, 0.5, 4, 16]} />
          <meshStandardMaterial color={color} roughness={0.35} metalness={0.25} />
        </mesh>
        {/* Head */}
        <mesh position={[0, FACE_OFFSET_Y + 0.35, 0]} castShadow>
          <sphereGeometry args={[0.22, 24, 18]} />
          <meshStandardMaterial color={color} roughness={0.4} metalness={0.5} />
        </mesh>
        {/* Eyes (glowing visor band) */}
        <mesh position={[0, FACE_OFFSET_Y + 0.36, 0.18]}>
          <boxGeometry args={[0.22, 0.07, 0.02]} />
          <meshStandardMaterial color="#0ea5e9" emissive="#67e8f9" emissiveIntensity={1.8} toneMapped={false} />
        </mesh>
        {/* Arms */}
        <mesh ref={armL} position={[-0.35, 0.85, 0]} castShadow>
          <capsuleGeometry args={[0.07, 0.42, 4, 12]} />
          <meshStandardMaterial color={color} roughness={0.4} metalness={0.3} />
        </mesh>
        <mesh ref={armR} position={[ 0.35, 0.85, 0]} castShadow>
          <capsuleGeometry args={[0.07, 0.42, 4, 12]} />
          <meshStandardMaterial color={color} roughness={0.4} metalness={0.3} />
        </mesh>
        {/* Legs */}
        <mesh ref={legL} position={[-0.12, 0.25, 0]} castShadow>
          <capsuleGeometry args={[0.08, 0.36, 4, 12]} />
          <meshStandardMaterial color={color} roughness={0.4} metalness={0.3} />
        </mesh>
        <mesh ref={legR} position={[ 0.12, 0.25, 0]} castShadow>
          <capsuleGeometry args={[0.08, 0.36, 4, 12]} />
          <meshStandardMaterial color={color} roughness={0.4} metalness={0.3} />
        </mesh>
        {/* Name label */}
        <Text position={[0, 1.7, 0]} fontSize={0.13} color="#ffffff" anchorX="center" anchorY="middle" outlineWidth={0.005} outlineColor="#040414">
          {label}
        </Text>
        <SpeechBubble agentId={id} />
      </group>
    </RigidBody>
  );
}

function SpeechBubble({ agentId }: { agentId: string }) {
  const lastSpeech = useWorld(s => s.agents[agentId]?.lastSpeech);
  if (!lastSpeech) return null;
  // Fade after 4 seconds
  const age = (Date.now() - lastSpeech.ts) / 1000;
  if (age > 4) return null;
  return (
    <Html position={[0, 2.0, 0]} center distanceFactor={6} occlude={false}>
      <div className="pointer-events-none whitespace-nowrap rounded-full border border-cyan-400/40 bg-[#0a1224]/90 px-3 py-1 text-[10px] text-cyan-100 shadow-lg shadow-cyan-500/10 backdrop-blur" style={{ opacity: Math.max(0, 1 - age / 4) }}>
        {lastSpeech.text.slice(0, 70)}{lastSpeech.text.length > 70 ? '…' : ''}
      </div>
    </Html>
  );
}

function buildPerception(
  id: string, label: string, pos: THREE.Vector3,
  m: AgentPerception['S_t']['mood'], energy: number,
  momentum: string[], interactables: Interactable[], tick: number,
): AgentPerception {
  // Compute "location_label" — coarse semantic position
  let locationLabel: AgentPerception['S_t']['location_label'] = 'floor';
  for (const v of interactables) {
    const d = dist({ x: pos.x, y: pos.y, z: pos.z }, v.position);
    if (v.kind === 'couch' && d < 1.2) locationLabel = 'couch';
    else if (v.kind === 'tv' && d < 1.4) locationLabel = 'near_tv';
    else if (v.kind === 'glass_wall' && d < 1.0) locationLabel = 'near_glass';
  }
  // Visible = within 8m radius. Also annotate broken walls.
  const brokenWalls = world.get().brokenWalls;
  const visible = interactables
    .filter(v => dist({ x: pos.x, y: pos.y, z: pos.z }, v.position) < 8 && v.id !== id)
    .map(v => v.kind === 'glass_wall' && brokenWalls.has(v.id) ? { ...v, notes: 'broken' } : v);
  const holding = world.get().agents[id]?.holding ?? null;

  // Decide a goal
  let objective: AgentPerception['S_g']['objective'] = 'explore';
  if (energy < 0.25) objective = 'observe';
  if (holding) objective = 'interact';
  if (momentum.slice(-3).every(a => a.startsWith('walk_to'))) objective = 'interact';
  if (visible.some(v => v.kind === 'glass_wall' && v.notes === 'broken')) {
    // Curious agents notice broken walls and may attempt escape.
    if (Math.random() < 0.3) objective = 'escape';
  }

  return {
    S_t: {
      id, label,
      position: { x: pos.x, y: pos.y, z: pos.z },
      facing: 0,
      holding,
      mood: m,
      energy,
      location_label: locationLabel,
    },
    S_g: { objective, description: `${objective} the room` },
    momentum,
    visible,
    tick,
  };
}

function describeMomentum(a: AgentAction): string {
  return a.target_id ? `${a.type}:${a.target_id}` : a.type;
}

function lerp(a: number, b: number, t: number) { return a + (b - a) * Math.max(0, Math.min(1, t)); }
function wrapAngle(a: number) { while (a > Math.PI) a -= 2*Math.PI; while (a < -Math.PI) a += 2*Math.PI; return a; }
