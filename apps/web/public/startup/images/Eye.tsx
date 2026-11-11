import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { CreatureController } from "../controller";
import { eyeFragment, eyeVertex } from "../shaders/eye";

interface Props {
  controller: CreatureController;
}

export default function Eye({ controller }: Props) {
  const meshRef = useRef<THREE.Mesh>(null);
  const matRef = useRef<THREE.ShaderMaterial>(null);
  const lookTemp = useRef(new THREE.Vector3());

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uPupil: { value: 0.3 }
    }),
    []
  );

  useFrame((state) => {
    const snap = controller.snapshot;
    if (meshRef.current) {
      meshRef.current.position.copy(snap.eyePosition);
      lookTemp.current.copy(snap.lookTarget);
      meshRef.current.lookAt(lookTemp.current);
    }
    if (matRef.current) {
      matRef.current.uniforms.uTime.value = state.clock.elapsedTime;
      matRef.current.uniforms.uPupil.value = snap.pupil;
    }
  });

  return (
    <mesh ref={meshRef} scale={[0.36, 0.36, 0.36]} position={[0, 0.1, 0.5]}>
      <sphereGeometry args={[0.32, 64, 64]} />
      <shaderMaterial
        ref={matRef}
        vertexShader={eyeVertex}
        fragmentShader={eyeFragment}
        uniforms={uniforms}
        transparent={false}
        depthWrite
      />
    </mesh>
  );
}
