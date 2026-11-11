import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import type { CreatureController } from "../controller";

interface Props {
  controller: CreatureController;
}

export default function Limbs({ controller }: Props) {
  const limbCount = controller.snapshot.limbs.length;
  const refs = useRef<(THREE.Mesh | null)[]>([]);

  const material = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color("#7bd3ff"),
        emissive: new THREE.Color("#2a78ff"),
        emissiveIntensity: 0.8,
        roughness: 0.25,
        metalness: 0.15,
        transparent: true
      }),
    []
  );

  useFrame(() => {
    const snap = controller.snapshot;
    snap.limbs.forEach((limb, i) => {
      const mesh = refs.current[i];
      if (!mesh) return;
      mesh.position.copy(limb.position);
      const s = 0.26 * limb.swell;
      mesh.scale.setScalar(s);
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = 0.7 + limb.pulse * 1.4;
      mat.opacity = 0.75 + limb.pulse * 0.25;
    });
  });

  return (
    <group>
      {Array.from({ length: limbCount }).map((_, i) => (
        <mesh
          key={`limb-${i}`}
          ref={(m) => {
            refs.current[i] = m;
          }}
          material={material}
        >
          <sphereGeometry args={[0.32, 32, 32]} />
        </mesh>
      ))}
    </group>
  );
}
