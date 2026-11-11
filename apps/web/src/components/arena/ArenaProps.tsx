'use client';

import React, { useRef, useState, useEffect, useMemo } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import {
  Physics, RigidBody, CuboidCollider, BallCollider, CapsuleCollider,
  RapierRigidBody, useRapier, interactionGroups, vec3,
} from '@react-three/rapier';
import { OrbitControls, Environment, Sky, Text, ContactShadows } from '@react-three/drei';
import * as THREE from 'three';
import { MATERIALS, ROOM, TICK, GLASS_BREAK_KE_THRESHOLD, GLASS_SHARD_COUNT } from './physics';
import { world, useWorld } from './worldStore';
import {
  AgentBrain, ReflexBrain, HamiltonianBrain, RandomBrain,
  AgentPerception, AgentAction, Interactable, dist,
} from './AgentBrain';

// ────────────────────────────────────────────────────────────
//  Collision groups (membership / filter):
//   1=floor, 2=walls, 4=furniture, 8=agents, 16=props, 32=shards
// ────────────────────────────────────────────────────────────
const G = {
  floor:     interactionGroups(1,  0xFFFF),
  walls:     interactionGroups(2,  0xFFFF),
  furniture: interactionGroups(4,  0xFFFF),
  agents:    interactionGroups(8,  0xFFFF),
  props:     interactionGroups(16, 0xFFFF),
  shards:    interactionGroups(32, 0xFFFF),
};

// Color palette — bright playful office (Aether Dynamics style)
const PALETTE = {
  floor:    '#d4a76a',   // warm wood
  glass:    '#c8e6ff',   // light blue glass
  glassEdge:'#90cdf4',
  couch:    '#5eead4',
  table:    '#b07d42',   // warm wood table
  tv:       '#f0f0f4',   // light frame
  agentA:   '#3b82f6',   // blue
  agentB:   '#22c55e',   // green
  agentC:   '#f97316',   // orange
  agentD:   '#eab308',   // yellow
  cup:      '#fafafa',
  ball:     '#f97316',   // orange
  plant:    '#22c55e',   // vivid green
  sky:      '#e0eeff',   // light sky
};

// ────────────────────────────────────────────────────────────
//  ROOM (glass walls)
// ────────────────────────────────────────────────────────────
function Wall({
  id, position, size, broken,
}: { id: string; position: [number,number,number]; size: [number,number,number]; broken: boolean }) {
  if (broken) return null;
  const mat = MATERIALS.glass_wall;
  // Track damage state — show cracks as accumulated impact energy approaches threshold.
  const [damage, setDamage] = React.useState(0);
  return (
    <RigidBody
      type="fixed"
      colliders="cuboid"
      position={position}
      userData={{ kind: 'glass_wall', id }}
      friction={mat.friction}
      restitution={mat.restitution}
      collisionGroups={G.walls}
      onContactForce={(payload) => {
        // Estimate KE from contact impulse and relative mass.
        // Rapier provides total_force_magnitude on heavy contacts via this event.
        const force = payload.totalForceMagnitude;
        // Approximate KE-equivalent: force * 0.02 (kg.m^2 / s^2 per N)
        const ke = force * 0.02;
        if (ke > 0.5) {
          const next = Math.min(1, damage + ke / GLASS_BREAK_KE_THRESHOLD);
          setDamage(next);
          if (next >= 1) world.breakWall(id);
        }
      }}
    >
      <mesh castShadow receiveShadow>
        <boxGeometry args={size} />
        <meshPhysicalMaterial
          color={PALETTE.glass}
          metalness={0}
          roughness={0.05 + damage * 0.3}
          transmission={Math.max(0.45, 0.85 - damage * 0.4)}
          thickness={0.04}
          ior={1.45}
          transparent
          opacity={0.25 + damage * 0.25}
          envMapIntensity={1.4}
        />
      </mesh>
      {/* Edge highlight */}
      <mesh>
        <boxGeometry args={[size[0] * 1.001, size[1] * 1.001, size[2] * 1.001]} />
        <meshBasicMaterial color={damage > 0.5 ? '#fda4af' : PALETTE.glassEdge} wireframe opacity={0.18 + damage * 0.4} transparent />
      </mesh>
    </RigidBody>
  );
}

function Shards({ id, center, size }: { id: string; center: [number,number,number]; size: [number,number,number] }) {
  // Spawn GLASS_SHARD_COUNT small cuboid shards in the wall's footprint.
  const shards = useMemo(() => {
    const out: Array<{ pos: [number,number,number]; rot: [number,number,number]; sz: [number,number,number]; vel: [number,number,number] }> = [];
    for (let i = 0; i < GLASS_SHARD_COUNT; i++) {
      const px = center[0] + (Math.random() - 0.5) * size[0];
      const py = center[1] + (Math.random() - 0.5) * size[1];
      const pz = center[2] + (Math.random() - 0.5) * size[2];
      const sx = 0.05 + Math.random() * 0.4;
      const sy = 0.05 + Math.random() * 0.4;
      const sz = Math.max(0.02, size[2] * (0.6 + Math.random() * 0.4));
      const vx = (Math.random() - 0.5) * 3;
      const vy = Math.random() * 2.5;
      const vz = (Math.random() - 0.5) * 3;
      out.push({ pos: [px, py, pz], rot: [Math.random(), Math.random(), Math.random()], sz: [sx, sy, sz], vel: [vx, vy, vz] });
    }
    return out;
  }, [id, center, size]);
  const mat = MATERIALS.glass_shard;
  return <>
    {shards.map((s, i) => (
      <RigidBody
        key={`${id}-${i}`}
        position={s.pos}
        rotation={s.rot}
        linearVelocity={s.vel}
        colliders="cuboid"
        friction={mat.friction}
        restitution={mat.restitution}
        linearDamping={mat.linearDamping}
        angularDamping={mat.angularDamping}
        collisionGroups={G.shards}
      >
        <mesh castShadow>
          <boxGeometry args={s.sz} />
          <meshPhysicalMaterial
            color={PALETTE.glass}
            transmission={0.6}
            roughness={0.15}
            thickness={0.02}
            transparent
            opacity={0.6}
          />
        </mesh>
      </RigidBody>
    ))}
  </>;
}

function Floor() {
  const mat = MATERIALS.floor;
  return (
    <RigidBody type="fixed" friction={mat.friction} restitution={mat.restitution} collisionGroups={G.floor}>
      <mesh receiveShadow rotation={[-Math.PI/2, 0, 0]} position={[0, 0, 0]}>
        <planeGeometry args={[ROOM.width * 4, ROOM.depth * 4]} />
        <meshStandardMaterial color={PALETTE.floor} roughness={0.55} metalness={0.02} />
      </mesh>
      <CuboidCollider args={[ROOM.width * 2, 0.05, ROOM.depth * 2]} position={[0, -0.05, 0]} />
    </RigidBody>
  );
}

function Ceiling() {
  return (
    <mesh position={[0, ROOM.height, 0]} rotation={[Math.PI/2, 0, 0]}>
      <planeGeometry args={[ROOM.width, ROOM.depth]} />
      <meshStandardMaterial color="#f5f5f5" roughness={0.9} side={THREE.DoubleSide} />
    </mesh>
  );
}

export function Room() {
  const broken = useWorld(s => s.brokenWalls);
  // Wall positions and sizes
  const W = ROOM.wallThickness;
  const walls = [
    { id: 'wall_back',  position: [0, ROOM.height/2, -ROOM.depth/2] as [number,number,number], size: [ROOM.width, ROOM.height, W] as [number,number,number] },
    { id: 'wall_front', position: [0, ROOM.height/2,  ROOM.depth/2] as [number,number,number], size: [ROOM.width, ROOM.height, W] as [number,number,number] },
    { id: 'wall_left',  position: [-ROOM.width/2, ROOM.height/2, 0] as [number,number,number], size: [W, ROOM.height, ROOM.depth] as [number,number,number] },
    { id: 'wall_right', position: [ ROOM.width/2, ROOM.height/2, 0] as [number,number,number], size: [W, ROOM.height, ROOM.depth] as [number,number,number] },
  ];
  return <>
    <Floor />
    <Ceiling />
    {walls.map(w => (
      <React.Fragment key={w.id}>
        <Wall id={w.id} position={w.position} size={w.size} broken={broken.has(w.id)} />
        {broken.has(w.id) && <Shards id={w.id} center={w.position} size={w.size} />}
      </React.Fragment>
    ))}
  </>;
}

// ────────────────────────────────────────────────────────────
//  FURNITURE
// ────────────────────────────────────────────────────────────
export function Couch({ position }: { position: [number,number,number] }) {
  const mat = MATERIALS.couch;
  return (
    <RigidBody
      type="fixed"
      position={position}
      colliders={false}
      userData={{ kind: 'couch', id: 'couch1', seatY: position[1] + 0.55 }}
      friction={mat.friction}
      restitution={mat.restitution}
      collisionGroups={G.furniture}
    >
      {/* Base */}
      <mesh castShadow receiveShadow position={[0, 0.25, 0]}>
        <boxGeometry args={[2.2, 0.5, 0.9]} />
        <meshStandardMaterial color={PALETTE.couch} roughness={0.7} metalness={0.02} />
      </mesh>
      {/* Backrest */}
      <mesh castShadow position={[0, 0.85, -0.35]}>
        <boxGeometry args={[2.2, 0.7, 0.2]} />
        <meshStandardMaterial color={PALETTE.couch} roughness={0.7} />
      </mesh>
      {/* Arms */}
      <mesh castShadow position={[-1.0, 0.65, 0]}><boxGeometry args={[0.2, 0.8, 0.9]} /><meshStandardMaterial color={PALETTE.couch} roughness={0.7} /></mesh>
      <mesh castShadow position={[ 1.0, 0.65, 0]}><boxGeometry args={[0.2, 0.8, 0.9]} /><meshStandardMaterial color={PALETTE.couch} roughness={0.7} /></mesh>
      <CuboidCollider args={[1.1, 0.25, 0.45]} position={[0, 0.25, 0]} />
      <CuboidCollider args={[1.1, 0.35, 0.1]} position={[0, 0.85, -0.35]} />
      <CuboidCollider args={[0.1, 0.4, 0.45]} position={[-1.0, 0.65, 0]} />
      <CuboidCollider args={[0.1, 0.4, 0.45]} position={[ 1.0, 0.65, 0]} />
    </RigidBody>
  );
}

export function Table({ position }: { position: [number,number,number] }) {
  const mat = MATERIALS.table;
  return (
    <RigidBody
      type="fixed"
      position={position}
      colliders={false}
      userData={{ kind: 'table', id: 'table1' }}
      friction={mat.friction}
      restitution={mat.restitution}
      collisionGroups={G.furniture}
    >
      <mesh castShadow receiveShadow position={[0, 0.4, 0]}>
        <boxGeometry args={[1.2, 0.05, 0.7]} />
        <meshStandardMaterial color={PALETTE.table} roughness={0.5} metalness={0.2} />
      </mesh>
      {[[-0.55,-0.3],[ 0.55,-0.3],[-0.55,0.3],[ 0.55,0.3]].map(([x,z], i) => (
        <mesh key={i} castShadow position={[x, 0.2, z]}>
          <cylinderGeometry args={[0.025, 0.025, 0.4, 12]} />
          <meshStandardMaterial color="#1a2030" metalness={0.4} roughness={0.3} />
        </mesh>
      ))}
      <CuboidCollider args={[0.6, 0.025, 0.35]} position={[0, 0.4, 0]} />
    </RigidBody>
  );
}

export function TV({ position, channels }: { position: [number,number,number]; channels: { color: string; label: string }[] }) {
  const mat = MATERIALS.tv;
  const channel = useWorld(s => s.tvChannel['tv1'] ?? 0);
  const ch = channels[channel % channels.length];
  return (
    <RigidBody
      type="fixed"
      position={position}
      colliders={false}
      userData={{ kind: 'tv', id: 'tv1', channelCount: channels.length }}
      friction={mat.friction}
      restitution={mat.restitution}
      collisionGroups={G.furniture}
    >
      {/* Wall mount */}
      <mesh castShadow position={[0, 0, 0.03]}>
        <boxGeometry args={[1.8, 1.0, 0.06]} />
        <meshStandardMaterial color={PALETTE.tv} roughness={0.4} metalness={0.5} />
      </mesh>
      {/* Screen */}
      <mesh position={[0, 0, 0.07]}>
        <planeGeometry args={[1.65, 0.85]} />
        <meshBasicMaterial color={ch.color} toneMapped={false} />
      </mesh>
      <Text position={[0, 0, 0.075]} fontSize={0.12} color="#ffffff" anchorX="center" anchorY="middle">
        {ch.label}
      </Text>
      <CuboidCollider args={[0.9, 0.5, 0.03]} position={[0, 0, 0.03]} />
    </RigidBody>
  );
}

export function Plant({ position }: { position: [number,number,number] }) {
  const mat = MATERIALS.plant;
  return (
    <RigidBody
      type="dynamic"
      position={position}
      colliders={false}
      userData={{ kind: 'plant', id: 'plant1' }}
      friction={mat.friction}
      restitution={mat.restitution}
      linearDamping={mat.linearDamping}
      angularDamping={mat.angularDamping}
      collisionGroups={G.furniture}
    >
      <mesh castShadow position={[0, 0.15, 0]}>
        <cylinderGeometry args={[0.18, 0.12, 0.3, 16]} />
        <meshStandardMaterial color="#3a2a1a" roughness={0.8} />
      </mesh>
      <mesh castShadow position={[0, 0.6, 0]}>
        <icosahedronGeometry args={[0.32, 0]} />
        <meshStandardMaterial color={PALETTE.plant} roughness={0.7} flatShading />
      </mesh>
      <CylinderCollider args={[0.15, 0.18]} position={[0, 0.15, 0]} />
      <BallCollider args={[0.32]} position={[0, 0.6, 0]} />
    </RigidBody>
  );
}

function CylinderCollider({ args, position }: { args: [number, number]; position: [number,number,number] }) {
  // @react-three/rapier doesn't export CylinderCollider directly; use a CuboidCollider approximation
  return <CuboidCollider args={[args[1], args[0], args[1]]} position={position} />;
}

export function Cup({ position, id }: { position: [number,number,number]; id: string }) {
  const mat = MATERIALS.cup;
  return (
    <RigidBody
      type="dynamic"
      position={position}
      colliders={false}
      userData={{ kind: 'cup', id }}
      ccd
      friction={mat.friction}
      restitution={mat.restitution}
      linearDamping={mat.linearDamping}
      angularDamping={mat.angularDamping}
      collisionGroups={G.props}
    >
      <mesh castShadow>
        <cylinderGeometry args={[0.04, 0.035, 0.1, 16]} />
        <meshStandardMaterial color={PALETTE.cup} roughness={0.4} metalness={0.05} />
      </mesh>
      <CuboidCollider args={[0.04, 0.05, 0.04]} />
    </RigidBody>
  );
}

export function Ball({ position, id, color }: { position: [number,number,number]; id: string; color?: string }) {
  const mat = MATERIALS.ball;
  return (
    <RigidBody
      type="dynamic"
      position={position}
      colliders={false}
      userData={{ kind: 'ball', id }}
      ccd
      friction={mat.friction}
      restitution={mat.restitution}
      linearDamping={mat.linearDamping}
      angularDamping={mat.angularDamping}
      collisionGroups={G.props}
    >
      <mesh castShadow>
        <sphereGeometry args={[0.07, 24, 18]} />
        <meshStandardMaterial color={color ?? PALETTE.ball} roughness={0.5} />
      </mesh>
      <BallCollider args={[0.07]} />
    </RigidBody>
  );
}

export function Drone({ position }: { position: [number,number,number] }) {
  const mat = MATERIALS.drone;
  return (
    <RigidBody
      type="dynamic"
      position={position}
      colliders={false}
      userData={{ kind: 'drone', id: 'drone1' }}
      ccd
      friction={mat.friction}
      restitution={mat.restitution}
      linearDamping={mat.linearDamping}
      angularDamping={mat.angularDamping}
      collisionGroups={G.props}
    >
      <mesh castShadow>
        <boxGeometry args={[0.3, 0.06, 0.3]} />
        <meshStandardMaterial color="#1f2536" metalness={0.55} roughness={0.4} />
      </mesh>
      {/* Rotors */}
      {[[-0.15, 0.04, -0.15],[0.15, 0.04, -0.15],[-0.15, 0.04, 0.15],[0.15, 0.04, 0.15]].map(([x,y,z], i) => (
        <mesh key={i} position={[x,y,z]}>
          <cylinderGeometry args={[0.06, 0.06, 0.01, 16]} />
          <meshStandardMaterial color="#67e8f9" emissive="#5eead4" emissiveIntensity={0.4} />
        </mesh>
      ))}
      <CuboidCollider args={[0.15, 0.04, 0.15]} />
    </RigidBody>
  );
}

export function Bookshelf({ position }: { position: [number,number,number] }) {
  const bookColors = ['#2d3a55', '#3b4a65', '#4a5a75', '#1f2940', '#344056', '#5a3a3a', '#3a5a3a'];
  return (
    <RigidBody type="fixed" position={position} colliders={false} collisionGroups={G.furniture}>
      {/* Shelf frame */}
      <mesh castShadow>
        <boxGeometry args={[1.2, 2.0, 0.3]} />
        <meshStandardMaterial color="#1a1a2e" roughness={0.6} metalness={0.3} />
      </mesh>
      {/* Shelves */}
      {[0.35, -0.05, -0.45, -0.85].map((y, i) => (
        <mesh key={i} position={[0, y, 0]}>
          <boxGeometry args={[1.15, 0.02, 0.28]} />
          <meshStandardMaterial color="#20293d" roughness={0.5} metalness={0.2} />
        </mesh>
      ))}
      {/* Books */}
      {[0.55, 0.15, -0.25, -0.65].map((shelfY, si) =>
        Array.from({ length: 6 + Math.floor(Math.random() * 3) }).map((_, bi) => {
          const w = 0.06 + Math.random() * 0.06;
          const h = 0.25 + Math.random() * 0.12;
          const xOffset = -0.45 + bi * 0.13 + (Math.random() - 0.5) * 0.02;
          return (
            <mesh key={`${si}-${bi}`} position={[xOffset, shelfY + h / 2 + 0.01, 0]}>
              <boxGeometry args={[w, h, 0.2]} />
              <meshStandardMaterial color={bookColors[(si * 7 + bi) % bookColors.length]} roughness={0.7} />
            </mesh>
          );
        })
      )}
      <CuboidCollider args={[0.6, 1.0, 0.15]} />
    </RigidBody>
  );
}

export function Whiteboard({ position }: { position: [number,number,number] }) {
  return (
    <RigidBody type="fixed" position={position} colliders="cuboid" collisionGroups={G.furniture}>
      {/* Frame — light aluminum */}
      <mesh castShadow>
        <boxGeometry args={[2.2, 1.3, 0.04]} />
        <meshStandardMaterial color="#e0e0e4" roughness={0.2} metalness={0.4} />
      </mesh>
      {/* Screen surface — dark for branding */}
      <mesh position={[0, 0, 0.025]}>
        <planeGeometry args={[2.0, 1.1]} />
        <meshStandardMaterial color="#0a1628" roughness={0.1} metalness={0.02} />
      </mesh>
    </RigidBody>
  );
}

export function NeonStrip({ from, to, color }: { from: [number,number,number]; to: [number,number,number]; color?: string }) {
  const c = color ?? '#5eead4';
  const mid: [number,number,number] = [(from[0]+to[0])/2, (from[1]+to[1])/2, (from[2]+to[2])/2];
  const len = Math.sqrt((to[0]-from[0])**2 + (to[1]-from[1])**2 + (to[2]-from[2])**2);
  const dir = new THREE.Vector3(to[0]-from[0], to[1]-from[1], to[2]-from[2]).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0), dir);
  return (
    <mesh position={mid} quaternion={q}>
      <cylinderGeometry args={[0.008, 0.008, len, 8]} />
      <meshBasicMaterial color={c} toneMapped={false} />
    </mesh>
  );
}

// ════════════════════════════════════════════════════════════
//  OFFICE PROPS — for /studio/office scene
//  Desk, Monitor, OfficeChair, FilingCabinet, GlassPartition
// ════════════════════════════════════════════════════════════

export function OfficeDesk({ position, rotation = [0,0,0] as [number,number,number] }: { position: [number,number,number]; rotation?: [number,number,number] }) {
  const mat = MATERIALS.table;
  return (
    <RigidBody
      type="fixed"
      position={position}
      rotation={rotation}
      colliders={false}
      userData={{ kind: 'table', id: `desk_${position.join('_')}` }}
      friction={mat.friction}
      restitution={mat.restitution}
      collisionGroups={G.furniture}
    >
      {/* Top — warm wood */}
      <mesh castShadow receiveShadow position={[0, 0.74, 0]}>
        <boxGeometry args={[1.6, 0.06, 0.8]} />
        <meshStandardMaterial color="#c4943e" roughness={0.45} metalness={0.05} />
      </mesh>
      {/* Legs — light wood */}
      {[[-0.7,-0.35],[ 0.7,-0.35],[-0.7,0.35],[ 0.7,0.35]].map(([x,z], i) => (
        <mesh key={i} castShadow position={[x, 0.37, z]}>
          <boxGeometry args={[0.06, 0.74, 0.06]} />
          <meshStandardMaterial color="#a07830" roughness={0.5} metalness={0.05} />
        </mesh>
      ))}
      <CuboidCollider args={[0.8, 0.03, 0.4]} position={[0, 0.74, 0]} />
    </RigidBody>
  );
}

export function Monitor({ position, rotation = [0,0,0] as [number,number,number], screenColor = '#0ea5e9' }: { position: [number,number,number]; rotation?: [number,number,number]; screenColor?: string }) {
  return (
    <RigidBody
      type="fixed"
      position={position}
      rotation={rotation}
      colliders={false}
      userData={{ kind: 'tv', id: `monitor_${position.join('_')}` }}
      collisionGroups={G.furniture}
    >
      {/* Stand base */}
      <mesh castShadow position={[0, 0.005, 0]}>
        <cylinderGeometry args={[0.12, 0.14, 0.01, 24]} />
        <meshStandardMaterial color="#0c1322" roughness={0.4} metalness={0.7} />
      </mesh>
      {/* Stand post */}
      <mesh castShadow position={[0, 0.12, 0]}>
        <boxGeometry args={[0.04, 0.24, 0.04]} />
        <meshStandardMaterial color="#0c1322" roughness={0.4} metalness={0.7} />
      </mesh>
      {/* Screen body */}
      <mesh castShadow position={[0, 0.32, 0]}>
        <boxGeometry args={[0.6, 0.36, 0.03]} />
        <meshStandardMaterial color="#0a0a0f" roughness={0.4} metalness={0.5} />
      </mesh>
      {/* Screen surface */}
      <mesh position={[0, 0.32, 0.018]}>
        <planeGeometry args={[0.56, 0.32]} />
        <meshBasicMaterial color={screenColor} toneMapped={false} />
      </mesh>
      {/* Glow */}
      <mesh position={[0, 0.32, 0.019]}>
        <planeGeometry args={[0.54, 0.30]} />
        <meshBasicMaterial color="#000" transparent opacity={0.2} />
      </mesh>
    </RigidBody>
  );
}

export function OfficeChair({ position, rotation = [0,0,0] as [number,number,number], color = '#3b82f6' }: { position: [number,number,number]; rotation?: [number,number,number]; color?: string }) {
  const mat = MATERIALS.couch;
  return (
    <RigidBody
      type="dynamic"
      position={position}
      rotation={rotation}
      colliders={false}
      userData={{ kind: 'couch', id: `chair_${position.join('_')}`, seatY: position[1] + 0.45 }}
      mass={6}
      friction={mat.friction}
      restitution={0.05}
      linearDamping={2.5}
      angularDamping={2.5}
      collisionGroups={G.furniture}
    >
      {/* Wheel base */}
      <mesh castShadow position={[0, 0.05, 0]}>
        <cylinderGeometry args={[0.32, 0.28, 0.04, 5]} />
        <meshStandardMaterial color="#b0b0b0" roughness={0.4} metalness={0.5} />
      </mesh>
      {/* Gas cylinder */}
      <mesh castShadow position={[0, 0.25, 0]}>
        <cylinderGeometry args={[0.025, 0.025, 0.4, 12]} />
        <meshStandardMaterial color="#999" metalness={0.5} roughness={0.3} />
      </mesh>
      {/* Seat — colorful */}
      <mesh castShadow position={[0, 0.46, 0]}>
        <boxGeometry args={[0.5, 0.08, 0.5]} />
        <meshStandardMaterial color={color} roughness={0.55} metalness={0.05} />
      </mesh>
      {/* Backrest — colorful */}
      <mesh castShadow position={[0, 0.78, -0.22]}>
        <boxGeometry args={[0.5, 0.62, 0.06]} />
        <meshStandardMaterial color={color} roughness={0.55} metalness={0.05} />
      </mesh>
      <CuboidCollider args={[0.25, 0.05, 0.25]} position={[0, 0.46, 0]} />
      <CuboidCollider args={[0.25, 0.31, 0.03]} position={[0, 0.78, -0.22]} />
    </RigidBody>
  );
}

export function FilingCabinet({ position }: { position: [number,number,number] }) {
  return (
    <RigidBody
      type="fixed"
      position={position}
      colliders="cuboid"
      userData={{ kind: 'table', id: `cabinet_${position.join('_')}` }}
      collisionGroups={G.furniture}
    >
      {/* Body — bright white/light gray */}
      <mesh castShadow receiveShadow position={[0, 0.55, 0]}>
        <boxGeometry args={[0.45, 1.1, 0.5]} />
        <meshStandardMaterial color="#e8e8e8" roughness={0.5} metalness={0.1} />
      </mesh>
      {/* Drawer faces */}
      {[0.18, 0.55, 0.92].map((y, i) => (
        <mesh key={i} position={[0, y, 0.251]}>
          <boxGeometry args={[0.42, 0.32, 0.005]} />
          <meshStandardMaterial color="#f0f0f0" roughness={0.4} metalness={0.1} />
        </mesh>
      ))}
      {/* Drawer pulls — colorful accents */}
      {[0.18, 0.55, 0.92].map((y, i) => (
        <mesh key={i} position={[0, y, 0.254]}>
          <boxGeometry args={[0.08, 0.02, 0.01]} />
          <meshStandardMaterial color={['#3b82f6','#22c55e','#f97316'][i]} />
        </mesh>
      ))}
    </RigidBody>
  );
}

export function GlassPartition({ position, size, rotation = [0,0,0] as [number,number,number] }: { position: [number,number,number]; size: [number,number,number]; rotation?: [number,number,number] }) {
  const mat = MATERIALS.glass_wall;
  return (
    <RigidBody
      type="fixed"
      position={position}
      rotation={rotation}
      colliders="cuboid"
      userData={{ kind: 'glass_wall', id: `partition_${position.join('_')}` }}
      friction={mat.friction}
      restitution={mat.restitution}
      collisionGroups={G.walls}
    >
      <mesh castShadow receiveShadow>
        <boxGeometry args={size} />
        <meshPhysicalMaterial
          color="#e8f4ff"
          metalness={0}
          roughness={0.05}
          transmission={0.92}
          thickness={0.04}
          ior={1.45}
          transparent
          opacity={0.15}
        />
      </mesh>
      {/* Top rail — light metal */}
      <mesh position={[0, size[1]/2 + 0.02, 0]}>
        <boxGeometry args={[size[0], 0.04, size[2] + 0.01]} />
        <meshStandardMaterial color="#c0c0c0" metalness={0.5} roughness={0.3} />
      </mesh>
    </RigidBody>
  );
}

// ════════════════════════════════════════════════════════════
//  DECORATIVE GEOMETRIC OBJECTS — colorful shapes
// ════════════════════════════════════════════════════════════

export function ColorCube({ position, color, size = 0.25 }: { position: [number,number,number]; color: string; size?: number }) {
  return (
    <RigidBody type="dynamic" position={position} colliders="cuboid" mass={1.5}
      friction={0.6} restitution={0.2} linearDamping={1.5} angularDamping={1.5}
      collisionGroups={G.props}
    >
      <mesh castShadow>
        <boxGeometry args={[size, size, size]} />
        <meshStandardMaterial color={color} roughness={0.4} metalness={0.05} />
      </mesh>
    </RigidBody>
  );
}

export function ColorSphere({ position, color, radius = 0.15 }: { position: [number,number,number]; color: string; radius?: number }) {
  return (
    <RigidBody type="dynamic" position={position} colliders={false} mass={1.0}
      friction={0.5} restitution={0.6} linearDamping={1.0} angularDamping={0.8}
      collisionGroups={G.props}
    >
      <mesh castShadow>
        <sphereGeometry args={[radius, 28, 22]} />
        <meshStandardMaterial color={color} roughness={0.35} metalness={0.05} />
      </mesh>
      <BallCollider args={[radius]} />
    </RigidBody>
  );
}

export function ColorPyramid({ position, color, size = 0.25 }: { position: [number,number,number]; color: string; size?: number }) {
  return (
    <RigidBody type="dynamic" position={position} colliders="hull" mass={1.2}
      friction={0.6} restitution={0.15} linearDamping={1.5} angularDamping={1.5}
      collisionGroups={G.props}
    >
      <mesh castShadow>
        <coneGeometry args={[size * 0.7, size, 4]} />
        <meshStandardMaterial color={color} roughness={0.4} metalness={0.05} />
      </mesh>
    </RigidBody>
  );
}

export function CeilingPipe({ from, to, color }: { from: [number,number,number]; to: [number,number,number]; color: string }) {
  const mid: [number,number,number] = [(from[0]+to[0])/2, (from[1]+to[1])/2, (from[2]+to[2])/2];
  const len = Math.sqrt((to[0]-from[0])**2 + (to[1]-from[1])**2 + (to[2]-from[2])**2);
  const dir = new THREE.Vector3(to[0]-from[0], to[1]-from[1], to[2]-from[2]).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0), dir);
  return (
    <mesh position={mid} quaternion={q}>
      <cylinderGeometry args={[0.025, 0.025, len, 8]} />
      <meshStandardMaterial color={color} roughness={0.3} metalness={0.3} />
    </mesh>
  );
}

// ════════════════════════════════════════════════════════════
//  AETHER DYNAMICS OFFICE COMPONENTS
// ════════════════════════════════════════════════════════════

/** Large oval conference table — center of the office */
export function ConferenceTable({ position = [0, 0, 0] as [number,number,number] }) {
  const mat = MATERIALS.table;
  return (
    <RigidBody type="fixed" friction={mat.friction} restitution={mat.restitution} collisionGroups={G.furniture}>
      {/* Table top — rounded rectangle */}
      <mesh position={[position[0], position[1] + 0.74, position[2]]} castShadow receiveShadow>
        <boxGeometry args={[3.2, 0.06, 1.8]} />
        <meshStandardMaterial color={PALETTE.table} roughness={0.4} metalness={0.05} />
      </mesh>
      {/* Rounded edge feel — top bevel */}
      <mesh position={[position[0], position[1] + 0.78, position[2]]}>
        <boxGeometry args={[3.15, 0.02, 1.75]} />
        <meshStandardMaterial color="#c8a26e" roughness={0.35} metalness={0.02} />
      </mesh>
      {/* Central pedestal base */}
      <mesh position={[position[0], position[1] + 0.35, position[2]]} castShadow>
        <cylinderGeometry args={[0.35, 0.45, 0.7, 16]} />
        <meshStandardMaterial color={PALETTE.table} roughness={0.45} metalness={0.02} />
      </mesh>
      {/* Base plate */}
      <mesh position={[position[0], position[1] + 0.02, position[2]]}>
        <cylinderGeometry args={[0.5, 0.5, 0.04, 16]} />
        <meshStandardMaterial color="#8b6f47" roughness={0.5} metalness={0.05} />
      </mesh>
      <CuboidCollider args={[1.6, 0.03, 0.9]} position={[position[0], position[1] + 0.74, position[2]]} />
    </RigidBody>
  );
}

/** Large floor-to-ceiling windows — left wall, lets in natural light */
export function WindowWall({ position = [-ROOM.width/2, ROOM.height/2, 0] as [number,number,number] }) {
  return (
    <group position={position}>
      {/* Window frames — vertical mullions */}
      {[-1.5, -0.5, 0.5, 1.5].map((x, i) => (
        <mesh key={i} position={[x, 0, 0]}>
          <boxGeometry args={[0.08, ROOM.height, 0.12]} />
          <meshStandardMaterial color="#e8e8e8" roughness={0.7} />
        </mesh>
      ))}
      {/* Horizontal frames */}
      {[ -ROOM.height/2 + 0.3, 0, ROOM.height/2 - 0.3].map((y, i) => (
        <mesh key={`h${i}`} position={[0, y, 0]}>
          <boxGeometry args={[ROOM.depth, 0.08, 0.12]} />
          <meshStandardMaterial color="#e8e8e8" roughness={0.7} />
        </mesh>
      ))}
      {/* Glass panes */}
      {[-1.0, 0, 1.0].map((x, i) => (
        <mesh key={`glass${i}`} position={[x, 0, 0]}>
          <planeGeometry args={[0.9, ROOM.height - 0.7]} />
          <meshStandardMaterial color="#e0f7ff" transparent opacity={0.25} side={THREE.DoubleSide} roughness={0.05} metalness={0.1} />
        </mesh>
      ))}
      {/* Light streaming in — volumetric glow planes */}
      <mesh position={[0.8, -0.2, 0]} rotation={[0, -Math.PI/2, 0]}>
        <planeGeometry args={[ROOM.depth * 0.8, ROOM.height * 0.6]} />
        <meshBasicMaterial color="#fff8e7" transparent opacity={0.08} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

/** Colorful geometric wall art — triangles and circles */
export function WallArt({ position, rotation = [0, 0, 0] as [number,number,number], shapes }: {
  position: [number,number,number];
  rotation?: [number,number,number];
  shapes: Array<{ type: 'triangle' | 'circle'; color: string; size: number; offset: [number,number] }>;
}) {
  return (
    <group position={position} rotation={rotation}>
      {/* White backing board */}
      <mesh>
        <planeGeometry args={[2.2, 1.6]} />
        <meshStandardMaterial color="#f8f8f8" roughness={0.9} />
      </mesh>
      {shapes.map((s, i) => {
        if (s.type === 'triangle') {
          const shape = new THREE.Shape();
          shape.moveTo(0, s.size);
          shape.lineTo(-s.size * 0.866, -s.size * 0.5);
          shape.lineTo(s.size * 0.866, -s.size * 0.5);
          shape.closePath();
          return (
            <mesh key={i} position={[s.offset[0], s.offset[1], 0.02]}>
              <shapeGeometry args={[shape]} />
              <meshStandardMaterial color={s.color} side={THREE.DoubleSide} />
            </mesh>
          );
        }
        return (
          <mesh key={i} position={[s.offset[0], s.offset[1], 0.02]}>
            <circleGeometry args={[s.size, 32]} />
            <meshStandardMaterial color={s.color} side={THREE.DoubleSide} />
          </mesh>
        );
      })}
    </group>
  );
}

/** Floating shelves with geometric toys */
export function Shelf({ position, rotation = [0, 0, 0] as [number,number,number], items }: {
  position: [number,number,number];
  rotation?: [number,number,number];
  items: Array<{ type: 'cube' | 'sphere' | 'pyramid' | 'cone'; color: string; size: number }>;
}) {
  return (
    <group position={position} rotation={rotation}>
      {/* Shelf board */}
      <RigidBody type="fixed" collisionGroups={G.furniture}>
        <mesh castShadow>
          <boxGeometry args={[1.4, 0.04, 0.35]} />
          <meshStandardMaterial color="#e8d5b5" roughness={0.6} />
        </mesh>
        <CuboidCollider args={[0.7, 0.02, 0.175]} />
      </RigidBody>
      {/* Brackets */}
      <mesh position={[-0.5, -0.08, 0]}>
        <boxGeometry args={[0.04, 0.12, 0.3]} />
        <meshStandardMaterial color="#c0c0c0" metalness={0.6} roughness={0.3} />
      </mesh>
      <mesh position={[0.5, -0.08, 0]}>
        <boxGeometry args={[0.04, 0.12, 0.3]} />
        <meshStandardMaterial color="#c0c0c0" metalness={0.6} roughness={0.3} />
      </mesh>
      {/* Toys on shelf */}
      {items.map((item, i) => {
        const x = -0.5 + (i * 0.35);
        const y = item.size / 2 + 0.02;
        if (item.type === 'cube') {
          return (
            <mesh key={i} position={[x, y, 0]} castShadow>
              <boxGeometry args={[item.size, item.size, item.size]} />
              <meshStandardMaterial color={item.color} roughness={0.3} />
            </mesh>
          );
        }
        if (item.type === 'sphere') {
          return (
            <mesh key={i} position={[x, y, 0]} castShadow>
              <sphereGeometry args={[item.size / 2, 16, 16]} />
              <meshStandardMaterial color={item.color} roughness={0.3} />
            </mesh>
          );
        }
        if (item.type === 'cone') {
          return (
            <mesh key={i} position={[x, y, 0]} castShadow>
              <coneGeometry args={[item.size / 2, item.size, 16]} />
              <meshStandardMaterial color={item.color} roughness={0.3} />
            </mesh>
          );
        }
        const shape = new THREE.Shape();
        shape.moveTo(0, item.size);
        shape.lineTo(-item.size * 0.5, -item.size * 0.3);
        shape.lineTo(item.size * 0.5, -item.size * 0.3);
        shape.closePath();
        return (
          <mesh key={i} position={[x, y, 0]} castShadow rotation={[0, Math.PI/4, 0]}>
            <extrudeGeometry args={[shape, { depth: item.size * 0.3, bevelEnabled: false }]} />
            <meshStandardMaterial color={item.color} roughness={0.3} />
          </mesh>
        );
      })}
    </group>
  );
}

/** Large Aether Dynamics screen on wall */
export function LargeScreen({ position, rotation = [0, 0, 0] as [number,number,number] }) {
  return (
    <group position={position} rotation={rotation}>
      {/* Screen bezel */}
      <mesh>
        <boxGeometry args={[2.4, 1.4, 0.06]} />
        <meshStandardMaterial color="#1a1a2e" roughness={0.4} metalness={0.3} />
      </mesh>
      {/* Screen surface — glow */}
      <mesh position={[0, 0, 0.04]}>
        <planeGeometry args={[2.2, 1.2]} />
        <meshStandardMaterial color="#f0f4ff" emissive="#e8eeff" emissiveIntensity={0.3} roughness={0.2} />
      </mesh>
      {/* Aether Dynamics logo text */}
      <Text
        position={[0, 0.15, 0.06]}
        fontSize={0.18}
        color="#3b82f6"
        anchorX="center"
        anchorY="middle"
        font="/fonts/inter-bold.woff"
      >
        AETHER
      </Text>
      <Text
        position={[0, -0.05, 0.06]}
        fontSize={0.12}
        color="#64748b"
        anchorX="center"
        anchorY="middle"
      >
        DYNAMICS
      </Text>
      {/* Decorative icons */}
      <mesh position={[-0.6, -0.35, 0.06]}>
        <boxGeometry args={[0.18, 0.18, 0.02]} />
        <meshStandardMaterial color="#3b82f6" />
      </mesh>
      <mesh position={[0, -0.35, 0.06]}>
        <sphereGeometry args={[0.09, 16, 16]} />
        <meshStandardMaterial color="#f97316" />
      </mesh>
      <mesh position={[0.6, -0.35, 0.06]}>
        <coneGeometry args={[0.09, 0.18, 16]} />
        <meshStandardMaterial color="#22c55e" />
      </mesh>
    </group>
  );
}

/** Large fiddle-leaf fig plant in pot */
export function FiddleLeafPlant({ position }: { position: [number,number,number] }) {
  return (
    <group position={position}>
      {/* Pot */}
      <RigidBody type="fixed" collisionGroups={G.furniture}>
        <mesh position={[0, 0.25, 0]} castShadow>
          <cylinderGeometry args={[0.22, 0.18, 0.5, 16]} />
          <meshStandardMaterial color="#e07a5f" roughness={0.8} />
        </mesh>
        <CuboidCollider args={[0.2, 0.25, 0.2]} position={[0, 0.25, 0]} />
      </RigidBody>
      {/* Soil */}
      <mesh position={[0, 0.48, 0]}>
        <cylinderGeometry args={[0.2, 0.2, 0.04, 16]} />
        <meshStandardMaterial color="#5c4033" roughness={0.95} />
      </mesh>
      {/* Stem */}
      <mesh position={[0, 0.9, 0]}>
        <cylinderGeometry args={[0.03, 0.04, 0.9, 8]} />
        <meshStandardMaterial color="#4a7c59" roughness={0.8} />
      </mesh>
      {/* Leaves — large fiddle shapes */}
      {[
        { pos: [0.15, 1.4, 0.1] as [number,number,number], rot: [0.3, 0.2, 0.5] as [number,number,number], scale: [0.18, 0.35, 0.02] as [number,number,number] },
        { pos: [-0.12, 1.55, -0.08] as [number,number,number], rot: [-0.2, -0.3, -0.4] as [number,number,number], scale: [0.16, 0.32, 0.02] as [number,number,number] },
        { pos: [0.08, 1.7, 0.05] as [number,number,number], rot: [0.1, 0.1, 0.2] as [number,number,number], scale: [0.15, 0.3, 0.02] as [number,number,number] },
        { pos: [-0.18, 1.25, 0.12] as [number,number,number], rot: [0.4, -0.2, -0.6] as [number,number,number], scale: [0.14, 0.28, 0.02] as [number,number,number] },
        { pos: [0.2, 1.6, -0.1] as [number,number,number], rot: [-0.3, 0.3, 0.7] as [number,number,number], scale: [0.17, 0.33, 0.02] as [number,number,number] },
      ].map((leaf, i) => (
        <mesh key={i} position={leaf.pos} rotation={leaf.rot} scale={leaf.scale} castShadow>
          <sphereGeometry args={[1, 8, 8]} />
          <meshStandardMaterial color="#2d6a4f" roughness={0.7} side={THREE.DoubleSide} />
        </mesh>
      ))}
    </group>
  );
}

/** Small desk plant */
export function SmallPlant({ position }: { position: [number,number,number] }) {
  return (
    <group position={position}>
      <RigidBody type="fixed" collisionGroups={G.furniture}>
        <mesh position={[0, 0.12, 0]} castShadow>
          <cylinderGeometry args={[0.1, 0.08, 0.24, 12]} />
          <meshStandardMaterial color="#fff" roughness={0.3} />
        </mesh>
        <CuboidCollider args={[0.1, 0.12, 0.1]} position={[0, 0.12, 0]} />
      </RigidBody>
      {/* Leaves */}
      {[0, 1, 2, 3, 4].map(i => {
        const angle = (i / 5) * Math.PI * 2;
        return (
          <mesh key={i} position={[Math.cos(angle) * 0.08, 0.28 + i * 0.04, Math.sin(angle) * 0.08]} rotation={[0.4, angle, 0]} castShadow>
            <sphereGeometry args={[0.06, 8, 8]} />
            <meshStandardMaterial color="#40916c" roughness={0.7} side={THREE.DoubleSide} />
          </mesh>
        );
      })}
    </group>
  );
}

/** Modern pendant light */
export function PendantLight({ position, color }: { position: [number,number,number]; color: string }) {
  return (
    <group position={position}>
      <mesh position={[0, 0.15, 0]}>
        <cylinderGeometry args={[0.005, 0.005, 0.3, 6]} />
        <meshStandardMaterial color="#333" />
      </mesh>
      <mesh>
        <coneGeometry args={[0.15, 0.12, 16, 1, true]} />
        <meshStandardMaterial color={color} side={THREE.DoubleSide} roughness={0.4} />
      </mesh>
      <pointLight position={[0, -0.1, 0]} intensity={0.8} color={color} distance={4} decay={2} />
    </group>
  );
}
