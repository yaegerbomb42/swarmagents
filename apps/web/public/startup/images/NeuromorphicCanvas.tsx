"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Stars } from "@react-three/drei";
import * as THREE from "three";

interface Node {
  id: string;
  x: number;
  y: number;
  z: number;
  activationLevel: number;
  type: string;
}

interface Edge {
  sourceId: string;
  targetId: string;
  weight: number;
  isExcitatory: boolean;
}

const NetworkGraph = () => {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const groupRef = useRef<THREE.Group>(null);
  const linesRef = useRef<THREE.LineSegments>(null);
  const pointsRef = useRef<THREE.Points>(null);

  useEffect(() => {
    fetch("/api/network-state")
      .then(res => res.json())
      .then(data => {
        setNodes(data.nodes || []);
        setEdges(data.edges || []);
      })
      .catch(console.error);
      
    // Polling interval to simulate continuous time updates
    const interval = setInterval(() => {
      fetch("/api/network-state")
        .then(res => res.json())
        .then(data => {
          setNodes(data.nodes || []);
        });
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  // Compute geometries
  const { positions, colors, linePositions, lineColors } = useMemo(() => {
    const pos = new Float32Array(nodes.length * 3);
    const col = new Float32Array(nodes.length * 3);
    
    const nodeMap = new Map<string, Node>();
    
    nodes.forEach((n, i) => {
      pos[i * 3] = n.x;
      pos[i * 3 + 1] = n.y;
      pos[i * 3 + 2] = n.z;
      
      // Color based on activation
      const intensity = 0.2 + n.activationLevel * 0.8;
      let r = 0, g = 0, b = 0;
      if (n.type === "semantic") { r = intensity; g = intensity * 0.2; b = intensity; } // Purple
      else if (n.type === "episodic") { r = 0.1; g = intensity; b = intensity * 0.8; } // Cyan
      else { r = intensity; g = intensity; b = 0.2; } // Yellow

      col[i * 3] = r;
      col[i * 3 + 1] = g;
      col[i * 3 + 2] = b;
      
      nodeMap.set(n.id, n);
    });

    const validEdges = edges.filter(e => nodeMap.has(e.sourceId) && nodeMap.has(e.targetId));
    const lPos = new Float32Array(validEdges.length * 6);
    const lCol = new Float32Array(validEdges.length * 6);

    validEdges.forEach((e, i) => {
      const s = nodeMap.get(e.sourceId)!;
      const t = nodeMap.get(e.targetId)!;

      lPos[i * 6] = s.x; lPos[i * 6 + 1] = s.y; lPos[i * 6 + 2] = s.z;
      lPos[i * 6 + 3] = t.x; lPos[i * 6 + 4] = t.y; lPos[i * 6 + 5] = t.z;

      // Line color based on weight and excitatory/inhibitory
      const opacity = Math.max(0.1, e.weight);
      const edgeColor = e.isExcitatory ? [0.2, 0.5, 1.0] : [1.0, 0.2, 0.2]; // Blue for excitatory, Red for inhibitory

      lCol[i * 6] = edgeColor[0] * opacity; lCol[i * 6 + 1] = edgeColor[1] * opacity; lCol[i * 6 + 2] = edgeColor[2] * opacity;
      lCol[i * 6 + 3] = edgeColor[0] * opacity; lCol[i * 6 + 4] = edgeColor[1] * opacity; lCol[i * 6 + 5] = edgeColor[2] * opacity;
    });

    return { positions: pos, colors: col, linePositions: lPos, lineColors: lCol };
  }, [nodes, edges]);

  useFrame((state) => {
    if (groupRef.current) {
      // Global slow rotation (Simulating ambient state)
      groupRef.current.rotation.y += 0.001;
      groupRef.current.rotation.x += 0.0005;
    }
    
    // Simulate high-frequency "Gamma" oscillations via shader or material pulses
    const time = state.clock.getElapsedTime();
    if (pointsRef.current) {
      const pointMaterial = pointsRef.current.material as THREE.PointsMaterial;
      // Pulse effect
      pointMaterial.size = 0.5 + Math.sin(time * 5) * 0.1;
    }
  });

  return (
    <group ref={groupRef}>
      {positions.length > 0 && (
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
          <pointsMaterial size={0.6} vertexColors transparent opacity={0.8} sizeAttenuation />
        </points>
      )}

      {linePositions.length > 0 && (
        <lineSegments ref={linesRef}>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[linePositions, 3]}
            />
            <bufferAttribute
              attach="attributes-color"
              args={[lineColors, 3]}
            />
          </bufferGeometry>
          <lineBasicMaterial vertexColors transparent opacity={0.3} blending={THREE.AdditiveBlending} />
        </lineSegments>
      )}
    </group>
  );
};

export default function NeuromorphicCanvas() {
  return (
    <div className="absolute inset-0 z-0 bg-black">
      <Canvas camera={{ position: [0, 0, 35], fov: 60 }}>
        <color attach="background" args={["#000005"]} />
        <ambientLight intensity={0.5} />
        <NetworkGraph />
        <OrbitControls enablePan={false} enableZoom={true} autoRotate autoRotateSpeed={0.5} />
        <Stars radius={100} depth={50} count={5000} factor={4} saturation={0} fade speed={1} />
      </Canvas>
    </div>
  );
}
