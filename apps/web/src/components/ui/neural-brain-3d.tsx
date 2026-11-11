'use client';

import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

// ════════════════════════════════════════════════════════════
//  NeuralBrain3D — Emergent brain network of agent neurons
//  • Agents are neurons in a sphere of brain-like clustering
//  • Edges form as agents connect; new connections animate in
//  • Pulses travel down edges when agents communicate
//  • Pure three.js, no R3F for minimal bundle
// ════════════════════════════════════════════════════════════

export interface BrainAgent {
  id: string;
  role: string;
  label?: string;
  status?: 'idle' | 'firing' | 'learning' | 'sleeping';
  // Optional: explicit connections to other agent ids. If omitted, the
  // component infers them from role compatibility.
  connectedTo?: string[];
}

export interface NeuralBrain3DProps {
  agents?: BrainAgent[];
  className?: string;
  autoRotate?: boolean;
  pulseRate?: number;       // Hz — pulse spawn rate per edge
  onAgentClick?: (id: string) => void;
}

const ROLE_COLOR: Record<string, string> = {
  orchestrator: '#a5f3fc',
  reasoner:     '#a78bfa',
  executor:     '#67e8f9',
  validator:    '#5eead4',
  navigator:    '#fcd34d',
  memory:       '#f0abfc',
  perception:   '#fda4af',
  hamiltonian:  '#2dd4bf',
  default:      '#93c5fd',
};

const DEFAULT_AGENTS: BrainAgent[] = [
  { id: 'orch',     role: 'orchestrator', label: 'Conductor',     status: 'firing' },
  { id: 'ham',      role: 'hamiltonian',  label: 'Hamiltonian',   status: 'firing' },
  { id: 'reason',   role: 'reasoner',     label: 'Reasoner',      status: 'firing' },
  { id: 'reason2',  role: 'reasoner',     label: 'Synthesizer',   status: 'idle' },
  { id: 'exec',     role: 'executor',     label: 'Coder',         status: 'firing' },
  { id: 'exec2',    role: 'executor',     label: 'Refactorer',    status: 'idle' },
  { id: 'valid',    role: 'validator',    label: 'Critic',        status: 'firing' },
  { id: 'valid2',   role: 'validator',    label: 'Safety',        status: 'idle' },
  { id: 'nav',      role: 'navigator',    label: 'Codemap',       status: 'idle' },
  { id: 'mem',      role: 'memory',       label: 'LongTerm',      status: 'firing' },
  { id: 'mem2',     role: 'memory',       label: 'Episodic',      status: 'idle' },
  { id: 'percep',   role: 'perception',   label: 'Intent',        status: 'firing' },
];

// Brain-like sphere layout. We use a Fibonacci sphere then bias clusters
// per role so similar roles cluster together (like brain regions).
function layoutAgents(agents: BrainAgent[], radius = 1.6): THREE.Vector3[] {
  // Group by role for region-clustering
  const roles = Array.from(new Set(agents.map(a => a.role)));
  const roleCenter: Record<string, THREE.Vector3> = {};
  roles.forEach((r, i) => {
    const phi = Math.acos(1 - 2 * ((i + 0.5) / roles.length));
    const theta = Math.PI * (1 + Math.sqrt(5)) * i;
    roleCenter[r] = new THREE.Vector3(
      Math.sin(phi) * Math.cos(theta),
      Math.sin(phi) * Math.sin(theta),
      Math.cos(phi),
    ).multiplyScalar(radius * 0.95);
  });

  const positions: THREE.Vector3[] = [];
  const perRoleCount: Record<string, number> = {};
  agents.forEach((a) => {
    const c = roleCenter[a.role].clone();
    const k = (perRoleCount[a.role] = (perRoleCount[a.role] ?? 0) + 1);
    // Jitter around the role center on the sphere surface
    const jitter = new THREE.Vector3(
      (Math.random() - 0.5),
      (Math.random() - 0.5),
      (Math.random() - 0.5),
    ).multiplyScalar(0.45);
    const final = c.add(jitter).setLength(radius * (0.95 + Math.random() * 0.1));
    positions.push(final);
  });
  return positions;
}

// Infer connections based on role chemistry. Each agent connects to
// 2-3 nearest neighbors plus 1 role-affinity link.
function inferConnections(agents: BrainAgent[], positions: THREE.Vector3[]): [number, number][] {
  const out: [number, number][] = [];
  const added = new Set<string>();
  const ROLE_AFFINITIES: Record<string, string[]> = {
    orchestrator: ['hamiltonian', 'reasoner', 'executor', 'validator', 'memory', 'perception'],
    hamiltonian:  ['orchestrator', 'reasoner', 'executor'],
    reasoner:     ['executor', 'memory', 'validator'],
    executor:     ['validator', 'navigator'],
    validator:    ['executor', 'memory'],
    navigator:    ['executor', 'reasoner'],
    memory:       ['reasoner', 'validator'],
    perception:   ['orchestrator', 'reasoner'],
  };

  // Affinity links
  agents.forEach((a, i) => {
    const targets = ROLE_AFFINITIES[a.role] || ['orchestrator'];
    targets.forEach((tRole) => {
      const candidates = agents.map((x, j) => ({ x, j })).filter(({ x, j }) => x.role === tRole && j !== i);
      if (candidates.length === 0) return;
      // Pick the closest
      let bestIdx = candidates[0].j;
      let bestDist = positions[i].distanceTo(positions[bestIdx]);
      for (const c of candidates) {
        const d = positions[i].distanceTo(positions[c.j]);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = c.j;
        }
      }
      const key = i < bestIdx ? `${i}-${bestIdx}` : `${bestIdx}-${i}`;
      if (!added.has(key)) {
        added.add(key);
        out.push([Math.min(i, bestIdx), Math.max(i, bestIdx)]);
      }
    });
  });

  // 2 nearest neighbors per agent (regardless of role) for local clustering
  agents.forEach((_, i) => {
    const dists = agents
      .map((_, j) => ({ j, d: positions[i].distanceTo(positions[j]) }))
      .filter(({ j }) => j !== i)
      .sort((a, b) => a.d - b.d)
      .slice(0, 2);
    dists.forEach(({ j }) => {
      const key = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (!added.has(key)) {
        added.add(key);
        out.push([Math.min(i, j), Math.max(i, j)]);
      }
    });
  });

  return out;
}

export function NeuralBrain3D({
  agents = DEFAULT_AGENTS,
  className = '',
  autoRotate = true,
  pulseRate = 0.8,
  onAgentClick,
}: NeuralBrain3DProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [hovered, setHovered] = useState<BrainAgent | null>(null);
  const hoveredRef = useRef<BrainAgent | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const width = mount.clientWidth;
    const height = mount.clientHeight;

    // ── Scene + Camera + Renderer ────────────────────────
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    camera.position.set(0, 0, 5.5);

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    mount.appendChild(renderer.domElement);

    // ── Ambient cosmic glow background sphere ────────────
    const haloGeo = new THREE.SphereGeometry(3.2, 32, 32);
    const haloMat = new THREE.ShaderMaterial({
      uniforms: { c: { value: new THREE.Color('#0c1530') } },
      vertexShader: `
        varying float v;
        void main() {
          vec3 vn = normalize(normalMatrix * normal);
          v = pow(0.5 - dot(vn, vec3(0,0,1)), 3.0);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 c;
        varying float v;
        void main() {
          gl_FragColor = vec4(c, 1.0) * v * 0.9;
        }
      `,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
    });
    scene.add(new THREE.Mesh(haloGeo, haloMat));

    // ── Star dust ─────────────────────────────────────────
    const starsGeo = new THREE.BufferGeometry();
    const starCount = 400;
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const r = 6 + Math.random() * 6;
      const t = Math.random() * Math.PI * 2;
      const p = Math.acos(2 * Math.random() - 1);
      starPos[i * 3 + 0] = r * Math.sin(p) * Math.cos(t);
      starPos[i * 3 + 1] = r * Math.sin(p) * Math.sin(t);
      starPos[i * 3 + 2] = r * Math.cos(p);
    }
    starsGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    const starsMat = new THREE.PointsMaterial({
      color: 0xa5f3fc,
      size: 0.025,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.6,
    });
    scene.add(new THREE.Points(starsGeo, starsMat));

    // ── Layout neurons ───────────────────────────────────
    const positions = layoutAgents(agents, 1.6);

    // ── Neuron meshes ────────────────────────────────────
    const neuronGroup = new THREE.Group();
    scene.add(neuronGroup);

    type NeuronEntry = {
      mesh: THREE.Mesh;
      halo: THREE.Mesh;
      ring: THREE.Mesh;
      data: BrainAgent;
      ringPhase: number;
      pulsing: boolean;
    };

    const neurons: NeuronEntry[] = [];
    agents.forEach((a, i) => {
      const color = new THREE.Color(ROLE_COLOR[a.role] || ROLE_COLOR.default);

      // Core sphere
      const geo = new THREE.SphereGeometry(0.06, 24, 24);
      const mat = new THREE.MeshPhongMaterial({
        color,
        emissive: color,
        emissiveIntensity: a.status === 'firing' ? 1.2 : 0.5,
        shininess: 60,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(positions[i]);
      neuronGroup.add(mesh);

      // Outer halo (sprite-like glow)
      const haloG = new THREE.SphereGeometry(0.14, 16, 16);
      const haloM = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: a.status === 'firing' ? 0.35 : 0.1,
      });
      const halo = new THREE.Mesh(haloG, haloM);
      halo.position.copy(positions[i]);
      neuronGroup.add(halo);

      // Pulsing ring
      const ringG = new THREE.RingGeometry(0.12, 0.16, 32);
      const ringM = new THREE.MeshBasicMaterial({
        color,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.45,
      });
      const ring = new THREE.Mesh(ringG, ringM);
      ring.position.copy(positions[i]);
      ring.lookAt(0, 0, 0);
      neuronGroup.add(ring);

      neurons.push({
        mesh,
        halo,
        ring,
        data: a,
        ringPhase: Math.random() * Math.PI * 2,
        pulsing: a.status === 'firing',
      });
    });

    // ── Edges (synapses) ─────────────────────────────────
    const connections = inferConnections(agents, positions);
    const edgeGroup = new THREE.Group();
    scene.add(edgeGroup);

    type EdgeEntry = {
      line: THREE.Line;
      from: number;
      to: number;
      length: number;
      pulses: { progress: number; speed: number }[];
      bornAt: number;
    };

    const edges: EdgeEntry[] = [];
    const startNow = performance.now();
    connections.forEach(([from, to], idx) => {
      const start = positions[from];
      const end = positions[to];
      const color = new THREE.Color(ROLE_COLOR[agents[from].role] || ROLE_COLOR.default)
        .lerp(new THREE.Color(ROLE_COLOR[agents[to].role] || ROLE_COLOR.default), 0.5);

      // Curve via midpoint pulled outward (like neural arcs)
      const mid = start.clone().add(end).multiplyScalar(0.5).setLength(start.length() * 1.08);
      const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
      const pts = curve.getPoints(24);
      const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
      const lineMat = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0.5,
      });
      const line = new THREE.Line(lineGeo, lineMat);
      edgeGroup.add(line);

      edges.push({
        line,
        from,
        to,
        length: start.distanceTo(end),
        pulses: [],
        bornAt: startNow + idx * 30, // stagger edge fade-in to feel emergent
      });
    });

    // ── Pulse markers (small spheres traveling edges) ─────
    const pulseGeo = new THREE.SphereGeometry(0.035, 12, 12);

    // ── Lights ───────────────────────────────────────────
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dir = new THREE.DirectionalLight(0xa5f3fc, 0.7);
    dir.position.set(3, 2, 5);
    scene.add(dir);

    // ── Interaction: raycast for hover/click ─────────────
    const raycaster = new THREE.Raycaster();
    const mouseV = new THREE.Vector2();
    const onMove = (e: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      mouseV.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouseV.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouseV, camera);
      const intersects = raycaster.intersectObjects(neurons.map(n => n.mesh));
      if (intersects.length > 0) {
        const hit = neurons.find(n => n.mesh === intersects[0].object);
        if (hit && hit.data !== hoveredRef.current) {
          hoveredRef.current = hit.data;
          setHovered(hit.data);
          renderer.domElement.style.cursor = 'pointer';
        }
      } else if (hoveredRef.current) {
        hoveredRef.current = null;
        setHovered(null);
        renderer.domElement.style.cursor = 'grab';
      }
    };
    const onClick = () => {
      if (hoveredRef.current) onAgentClick?.(hoveredRef.current.id);
    };
    renderer.domElement.style.cursor = 'grab';
    renderer.domElement.addEventListener('mousemove', onMove);
    renderer.domElement.addEventListener('click', onClick);

    // Drag-to-rotate
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let userRotX = 0.2;
    let userRotY = 0;
    const onDown = (e: MouseEvent) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      renderer.domElement.style.cursor = 'grabbing';
    };
    const onUp = () => {
      dragging = false;
      renderer.domElement.style.cursor = 'grab';
    };
    const onDrag = (e: MouseEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      userRotY += dx * 0.005;
      userRotX += dy * 0.005;
      userRotX = Math.max(-1.2, Math.min(1.2, userRotX));
    };
    renderer.domElement.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('mousemove', onDrag);

    // ── Render loop ──────────────────────────────────────
    let raf = 0;
    const t0 = performance.now();

    const tick = () => {
      const t = (performance.now() - t0) / 1000;

      // Rotate the whole brain
      neuronGroup.rotation.y = userRotY + (autoRotate ? t * 0.06 : 0);
      neuronGroup.rotation.x = userRotX + (autoRotate ? Math.sin(t * 0.15) * 0.05 : 0);
      edgeGroup.rotation.copy(neuronGroup.rotation);

      // Pulse the firing neurons
      neurons.forEach((n) => {
        n.ringPhase += 0.04;
        const s = 1 + (Math.sin(n.ringPhase) + 1) * 0.7;
        n.ring.scale.set(s, s, s);
        (n.ring.material as THREE.MeshBasicMaterial).opacity = (n.pulsing ? 0.55 : 0.15) * (1 - (s - 1) / 1.5);

        // Mild halo pulse
        const haloS = 1 + Math.sin(n.ringPhase * 1.3) * 0.1;
        n.halo.scale.set(haloS, haloS, haloS);
      });

      // Edges: fade in based on bornAt; spawn pulses
      edges.forEach((e) => {
        const age = performance.now() - e.bornAt;
        if (age < 0) {
          (e.line.material as THREE.LineBasicMaterial).opacity = 0;
          return;
        }
        const fadeIn = Math.min(1, age / 800);
        (e.line.material as THREE.LineBasicMaterial).opacity = 0.15 + fadeIn * 0.35;

        // Spawn pulse with probability per frame (based on pulseRate Hz)
        // Approximation: 60fps → probability per frame = pulseRate/60
        if (
          neurons[e.from].pulsing &&
          neurons[e.to].pulsing &&
          Math.random() < pulseRate / 60
        ) {
          e.pulses.push({ progress: 0, speed: 0.6 + Math.random() * 0.6 });
        }
      });

      // Update + remove pulse sprites (rebuild each frame for simplicity)
      // Remove old pulse meshes
      const oldPulses = edgeGroup.children.filter((c) => (c as any).__pulse === true);
      oldPulses.forEach((p) => edgeGroup.remove(p));

      edges.forEach((e) => {
        const start = positions[e.from];
        const end = positions[e.to];
        const mid = start.clone().add(end).multiplyScalar(0.5).setLength(start.length() * 1.08);
        const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
        const color = (e.line.material as THREE.LineBasicMaterial).color;

        e.pulses = e.pulses.filter((p) => {
          p.progress += p.speed / 60;
          if (p.progress > 1) return false;
          const point = curve.getPointAt(p.progress);
          const mat = new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 1 - Math.abs(p.progress - 0.5) * 1.5,
          });
          const mesh = new THREE.Mesh(pulseGeo, mat);
          (mesh as any).__pulse = true;
          mesh.position.copy(point);
          edgeGroup.add(mesh);
          return true;
        });
      });

      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    // ── Resize ───────────────────────────────────────────
    const onResize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(mount);

    return () => {
      cancelAnimationFrame(raf);
      renderer.domElement.removeEventListener('mousemove', onMove);
      renderer.domElement.removeEventListener('click', onClick);
      renderer.domElement.removeEventListener('mousedown', onDown);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('mousemove', onDrag);
      ro.disconnect();
      mount.removeChild(renderer.domElement);
      renderer.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents.length]); // re-init on count change for emergent growth

  return (
    <div className={`relative w-full h-full ${className}`}>
      <div ref={mountRef} className="w-full h-full" />
      {hovered && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 pointer-events-none bg-gray-950/90 backdrop-blur-sm border border-cyan-500/30 rounded-xl px-3 py-1.5 text-xs text-white shadow-lg">
          <span className="font-semibold">{hovered.label || hovered.id}</span>
          <span className="text-cyan-300 ml-2 capitalize">· {hovered.role}</span>
        </div>
      )}
    </div>
  );
}

export default NeuralBrain3D;
