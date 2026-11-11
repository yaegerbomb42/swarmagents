import { Text } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";
import type { CreatureController, Particle } from "../controller";

interface Props {
  controller: CreatureController;
  particles: Pick<Particle, "id" | "char">[];
}

function Glyph({ controller, particle }: { controller: CreatureController; particle: Pick<Particle, "id" | "char"> }) {
  const ref = useRef<THREE.Mesh>(null);

  useFrame(() => {
    const data = controller.getParticle(particle.id);
    if (!data || !ref.current) return;
    ref.current.position.copy(data.position);
    ref.current.scale.setScalar(data.size);
    const mat = ref.current.material as THREE.Material & { opacity?: number; transparent?: boolean };
    mat.transparent = true;
    if (typeof mat.opacity === "number") {
      mat.opacity = data.opacity;
    }
  });

  return (
    <Text
      ref={ref}
      fontSize={0.22}
      color="#9cd8ff"
      anchorX="center"
      anchorY="middle"
      characters="abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!?.,;:-_+*/\\ "
      depthOffset={-1}
    >
      {particle.char}
    </Text>
  );
}

export default function TextParticles({ controller, particles }: Props) {
  return (
    <group>
      {particles.map((p) => (
        <Glyph key={`particle-${p.id}`} particle={p} controller={controller} />
      ))}
    </group>
  );
}
